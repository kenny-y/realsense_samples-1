// License: Apache 2.0. See LICENSE file in root directory.
// Copyright(c) 2016 Intel Corporation. All Rights Reserved.

'use strict';

let os = require('os');
let jpeg = require('jpeg-turbo');
let express = require('express');
let app = express();
let server = require('http').createServer(app);
let WsServer = require('ws').Server;
const orModule = require('object-recognition');

let or;
const options = {
  framesSkipping: 50,
};

orModule.createObjectRecognizer().then((objectRecognizer) => {
  startServer();
  or = objectRecognizer;
  or.on('framecaptured', () => {
    if (or.state !== 'running')
      return;
    or.getFrameData().then((frame) => {
      sendRgbFrame(frame);
    }).catch((e) => {
      console.log('error: ' + e);
    });
  });
  or.on('recognition', (results) => {
    printRecognitionData(results);
    sendRecognitionData(results);
  });

  return or.setObjectRecognitionOptions(options);
}).then(() => {
  return or.start();
}).then(() => {
  return or.getCameraOptions();
}).then((cameraOptions) => {
  let width = cameraOptions.color.width;
  let height = cameraOptions.color.height;
  let orOptions = {
    roi: new orModule.Rect2D(width/4, height/4, width/2, height/2),
  };
  return or.setObjectRecognitionOptions(orOptions);
}).catch((e) => {
  console.log('error: ' + e);
});

console.log('\n-------- Press Esc key to exit --------\n');

const ESC_KEY = '\u001b';
const CTRL_C = '\u0003';
let stdin = process.stdin;
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding('utf8');
stdin.on('data', function(key) {
  if (key === ESC_KEY || key === CTRL_C) {
    exit();
  }
});

function exit() {
  console.log('\n-------- Stopping --------');
  if (or) {
    or.stop().then(() => {
      process.exit();
    }).catch((error) => {
      console.log('error: ' + error);
      process.exit();
    });
  } else {
    process.exit();
  }
}

function padding(string, width) {
  if (!(string instanceof String))
    string = String(string);
  let length = width - string.length;
  if (length <= 0) return string;
  return string + new Array(length + 1).join(' ');
}

function printRecognitionData(results) {
  if (results.length === 0)
    return;
  const w = 18;
  let recognitionData = results[0];
  console.log(padding('Label', w), padding('Confidence', w));
  console.log(padding('-----', w), padding('----------', w));
  console.log(padding(recognitionData.label, w),
              padding(recognitionData.probability.toPrecision(2).toString(), w));
  console.log('');
}

function sendObjectList() {
  if (!connected) {
    return;
  }

  if (or) {
    or.getRecognizableObjectNames().then((objList) => {
      let resultToDisplay = {
        list: objList,
        type: 'object_recognition_label_list',
      };
      sendData(JSON.stringify(resultToDisplay));
    }).catch((error) => {
      console.log('error: ' + error);
    });
  }
}

function sendRecognitionData(results) {
  if (!connected) {
    return;
  }
  let recognitionData = results[0];
  let resultArray = [];
  let resultObject = {
    label: recognitionData.label,
    confidence: recognitionData.probability,
  };
  resultArray.push(resultObject);

  let resultToDisplay = {
    Object_result: resultArray,
    type: 'object_recognition',
  };
  sendData(JSON.stringify(resultToDisplay));
}

function sendRgbFrame(frame) {
  if (!connected)
    return;
  if (!frame || !frame.color)
    return;
  let useJpeg = true;
  let width = frame.color.width;
  let height = frame.color.height;
  let rawData = frame.color.data;

  let imageBuffer;
  let imageBufferLength;
  if (useJpeg) {
    imageBuffer = encodeToJPEG(rawData, width, height);
    imageBufferLength = imageBuffer.byteLength;
  } else {
    imageBuffer = rawData;
    imageBufferLength = rawData.length;
  }

  const msgHeaderLength = 16;
  let msg = new ArrayBuffer(msgHeaderLength + imageBufferLength);
  let int8View = new Uint8Array(msg);
  int8View.set(imageBuffer, msgHeaderLength);

  let int16View = new Uint16Array(msg, 0, msgHeaderLength);
  const MSG_RGB = 3;
  const FrameFormat = {
    Raw: 0,
    Jpeg: 1,
  };

  // The schema of the sent message:
  // |type|format|width|height|padding|time|data|
  // type: 1 byte, 3 means RGB frame data
  // format: 1 byte, 0 means raw data with out encoding, 1 means jpeg
  // width: 2 bytes, width of the frame data
  // height: 2 bytes, height of the frame data
  // padding: 2 bytes
  // time: 8 bytes, time stamp, not used currently.
  // data: the RGB data.
  int8View[0] = MSG_RGB;  // type
  if (useJpeg)
    int8View[1] = FrameFormat.Jpeg;  // format, jpeg
  else
    int8View[1] = FrameFormat.Raw;  // format, raw
  int16View[1] = width;
  int16View[2] = height;
  int16View[3] = 0;  // padding

  sendData(msg);
}

let clients = [];
let connected = false;

function sendData(data) {
  if (clients.length !== 0) {
    try {
      clients.forEach((client) => {
        client.send(data);
      });
    } catch (exception) {
      console.log('Exception: send data failed exception:', exception);
    }
  }
}

function encodeToJPEG(buffer, width, height) {
  let options = {
    format: jpeg.FORMAT_RGB,
    width: width,
    height: height,
    quality: 80,
  };
  let jpegImageData = jpeg.compressSync(buffer, options);
  return jpegImageData;
}

function getEthernetIp() {
  let ifaces = os.networkInterfaces();
  let ip = '';
  for (let ifname in ifaces) {
    if (ifname === undefined)
      continue;
    ifaces[ifname].forEach(function(iface) {
      if ('IPv4' !== iface.family || iface.internal !== false) {
        return;
      }
      ip = iface.address;
    });
    if (ip !== '')
      return ip;
  }
  return ip;
}

function startServer() {
  // Share the ui-browser code from cpp sample
  app.use(express.static('../cpp/ui-browser'));
  const ip = getEthernetIp();
  const port = 8000;
  server.listen(port, ip);
  let wss = new WsServer({
    server: server,
  });

  console.log('\nEthernet ip:' + ip);
  console.log(' >>> point your browser to: http://' + ip + ':' + port + '/view.html');

  wss.on('connection', function(client) {
    console.log('server: got connection ' + client._socket.remoteAddress + ':' +
        client._socket.remotePort);
    clients.push(client);
    if (!connected)
      connected = true;
    sendObjectList();
    client.on('close', function() {
      console.log('server: disconnect ' + client._socket.remoteAddress + ':' +
          client._socket.remotePort);
      let index = clients.indexOf(client);
      if (index > -1) {
        clients.splice(index, 1);
      }
      if (clients.length === 0)
        connected = false;
    });
  });
}
