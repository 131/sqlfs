"use strict";


const Sqlfs  = require('.');


class foo {

  async run() {
    let test = new Sqlfs("foo.sqlite");

    await test.warmup();


    await test.mkdirp("/foo/de");
    await test.touch("/foo/de/bar");

  }


}


module.exports = foo;