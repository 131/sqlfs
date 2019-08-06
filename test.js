"use strict";


const Sqlfs  = require('.');


class foo {

  async run() {
    let test = new Sqlfs("foo.sqlite");

    await test.warmup();

    await test.load(payload);
    console.log(test.serialize());

    await test.mkdirp("/foo/de");
    await test.touch("/foo/de/bar");


  }


}

const payload = [{
  file_path  : '/foo/de/bar',
  file_size  : 0,
  block_hash : 'd41d8cd98f00b204e9800998ecf8427e',
  file_mode  : 33206
}];

module.exports = foo;
