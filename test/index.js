"use strict";

const fs = require('fs');
const path = require('path');

const expect = require('expect.js');
const tmppath = require('nyks/fs/tmppath');
const Sqlfs  = require('..');
const fuse = require('../lib/fuse');
const guid = require('mout/random/guid');


/**
* See errors table https://www-numi.fnal.gov/offline_software/srt_public_context/WebDocs/Errors/unix_system_errors.html
*/

describe("initial test suite", function() {
  let ctx, tmpfile = tmppath("sqlite");

  before("should create a brand new fs", async () => {
    console.log("Working with", tmpfile);
    ctx = new Sqlfs(tmpfile);
    await ctx.warmup();
  });

  after("should cleanup all", async () => {
    await ctx.ctx.close();
    fs.unlinkSync(tmpfile);
  });

  it("should failed on accessing non absolute paths", async() => {
    try {
      await ctx.getattr(`somepath`);
      expect().to.fail("Never here");
    } catch(err) {
      expect(err).to.eql(fuse.EINVAL);
    }
  });

  it("should support touch", async() => {
    let file_name  = guid();
    let res = await ctx.touch(`/${file_name}`);
    let stat = await ctx.getattr(`/${file_name}`);
    expect(stat).to.be.ok();
  });



  it("should refuse to rmdir a non empty directory", async() => {
    try {
      await ctx.rmdir(`/`);
      expect().to.fail("Never here");
    } catch(err) {
      expect(err).to.eql(fuse.ENOTEMPTY);
    }
  });


  it("should failed on touching file in non-existant directories", async() => {
    let parent_dir = guid();
    let file_name  = guid();
    try {
      await ctx.touch(`/${parent_dir}/${file_name}`);
      expect().to.fail("Never here");
    } catch(err) {
      expect(err).to.eql(fuse.ENOENT);
    }
    
  });




  it("should rename file", async() => {
    let file_name  = guid();
    await ctx.touch(`/${file_name}`);
    let inode = await ctx._get_entry(`/${file_name}`);
    let new_name = guid();
    await ctx.rename(`/${file_name}`, `/${new_name}`);
    
    let new_inode = await ctx._get_entry(`/${new_name}`);

      //new file exists
    expect(new_inode.file_uid).to.eql(inode.file_uid);

    //old file is missing
    try {
      await ctx.getattr(`/${file_name}`);
      expect().to.fail("Never here");
    } catch(err) {
      expect(err).to.eql(fuse.ENOENT);
    }
  });

  it("should support recursive mkdir", async() => {
    let file_path = "/this/is/a/ path /with/subdirectories";
    await ctx.mkdirp(file_path);
    let stat = await ctx.getattr(file_path);
    expect(stat).to.be.ok();
  });

  it("should reject non recursive mkdir", async() => {
    let file_path = "/this/is/another/path/with/subdirectories";

    try {
      await ctx.mkdir(file_path);
      expect().to.fail("Never here");
    } catch(err) {
      expect(err).to.eql(fuse.ENOENT);
    }

  });


  it("should rename subdirectories and file", async() => {
    let file_path = "/this/is/a/ path /with/subdirectories/and/a/file";
    await ctx.mkdirp(path.dirname(file_path));
    await ctx.touch(file_path);
    let inode = await ctx._get_entry(file_path);

    await ctx.rename("/this", "/that");
    let new_inode = await ctx._get_entry("/that/is/a/ path /with/subdirectories/and/a/file");

    expect(new_inode.file_uid).to.eql(inode.file_uid);
  });





});