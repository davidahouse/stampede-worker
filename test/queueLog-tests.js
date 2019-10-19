'use strict';
/* eslint-env mocha */
const expect = require('chai').expect;
const mock = require('mock-require');

const someTask = {
  id: 42,
  title: 'Some task'
};

let writeFileSyncPath = null;
let writeFileSyncData = null;

mock('fs', {
  writeFileSync: function(path, data) {
    writeFileSyncPath = path;
    writeFileSyncData = data;
  }
});

const queueLog = require('../lib/queueLog');
queueLog.save('a-task-id', someTask, '/path/to/log');

mock.stop('fs');

describe('Queue Log', function() {
  beforeEach(() => {});

  it('should write a file if save is called', function() {
    expect(writeFileSyncPath).to.not.equal(null);
    expect(writeFileSyncData).to.not.equal(null);
  });

  it('should name the file correctly', function() {
    expect(writeFileSyncPath).to.equal('/path/to/log/a-task-id-1.log');
  });
});
