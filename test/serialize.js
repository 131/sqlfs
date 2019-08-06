"use strict";

const fs = require('fs');

const expect = require('expect.js');
const tmppath = require('nyks/fs/tmppath');
const Sqlfs  = require('..');




describe("serialize/load test suite", function() {
  let ctx, tmpfile = tmppath("sqlite");
  let mock = [{
    "file_path"  : "/this/is/a/path/to/check/withafile",
    "file_size"  : 0,
    "block_hash" : 'd41d8cd98f00b204e9800998ecf8427e',
    "file_mode"  : 33206,
  }];

  before("should create a brand new fs", async () => {
    console.log("Working with", tmpfile);
    ctx = new Sqlfs(tmpfile);
    await ctx.warmup();
  });

  after("should cleanup all", async () => {
    await ctx.ctx.close();
    fs.unlinkSync(tmpfile);
  });

  it("should test serialize", async () => {
    await ctx.mkdirp("/this/is/a/path/to/check");
    await ctx.touch("/this/is/a/path/to/check/withafile");

    expect(ctx.serialize()).to.eql(mock);
  });


  it("should test load", async () => {
    await ctx.init_fs();
    await ctx.warmup();
    await ctx.load(mock);

    expect(ctx.serialize()).to.eql(mock);
  });




});
