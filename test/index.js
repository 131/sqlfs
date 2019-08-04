"use strict";

const expect = require('expect.js');
const SQLFS  = require('..');

/**
* See errors table https://www-numi.fnal.gov/offline_software/srt_public_context/WebDocs/Errors/unix_system_errors.html
*/

describe("initial test suite", function() {
  let ctx;

  before("should create a brand new fs", async () => {
    ctx = new SQLFS();
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
    let res = await ctx.touch(`/{file_name}`);
    expect(res.file_uid).to.be.ok();
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
    ctx.touch(`/${parent_dir}/{$file_name}`);
  });




  it("should rename file", async() => {
    let file_name  = guid();
    let inode = await ctx.touch(`/${file_name}`);

    let new_name = guid();
    await ctx.rename(`/${file_name}`, `/${new_name}`);
    
    let new_inode = ctx.lookup(`/${new_name}`);

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
    let res = await ctx.mkdir(path.dirname(file_path), true);
    expect(res.file_uid).to.be.ok();
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
    await ctx.mkdir(path.dirname(file_path));
    let inode = await ctx.touch(file_path);

    await ctx.rename("/this", "/that");
    let new_inode = ctx.lookup("/that/is/a/ path /with/subdirectories/and/a/file");

    expect(new_inode.file_uid).to.eql(inode.file_uid);
  });





});