"use strict";

// make it work, make is fast, make it clean

const fs   = require('fs');
const path = require('path').posix;
const fuse = require('./lib/fuse'); //errors code only
const guid = require('mout/random/guid');
const update = require('mout/object/mixIn');

const md5 = require('nyks/crypto/md5');
const EMPTY_MD5 = md5('');


const {S_IFMT, S_IFREG, S_IFDIR} = fs.constants; //S_IFCHR, S_IFBLK, S_IFIFO, S_IFLNK, S_IFSOCK
//const {O_RDONLY, O_WRONLY, O_RDWR} = fs.constants;

const schema_version = 20190806;

const Context = require('osqlite/lnk'); //or 'osqlite'
const SQL = Context.SQL;

class Sqlfs {

  constructor(index_path) {
    this.index_path = index_path;
  }


  async init_fs() {
    if(this.ctx)
      await this.ctx.close();

    if(fs.existsSync(this.index_path))
      fs.unlinkSync(this.index_path);

    this.ctx = new Context(this.index_path);

    //create table structure
    await this.ctx.raw(`
     CREATE TABLE cloudfs_files_list (
      file_uid uuid NOT NULL CONSTRAINT cloudfs_files_list_pkey PRIMARY KEY,
      block_hash character varying(32),
      file_name character varying(128),
      parent_uid uuid NOT NULL,
      file_ctime integer DEFAULT (strftime('%s','now')) NOT NULL,
      file_mtime integer DEFAULT (strftime('%s','now')) NOT NULL,
      file_mode integer NOT NULL,
      CONSTRAINT cloudfs_files_list_parent_uid_foreign FOREIGN KEY (parent_uid) REFERENCES cloudfs_files_list(file_uid) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
     );
    `);

    await this.ctx.raw(`
     CREATE UNIQUE INDEX cloudfs_files_list_idx_1 ON cloudfs_files_list
      (file_name, parent_uid);
    `);

    await this.ctx.raw(`PRAGMA user_version = ${schema_version};`);

    let file_uid = guid();
    let file_name = '';
    let file_mode = (S_IFMT & S_IFDIR) | 0o777;
    let root = {file_uid, parent_uid : file_uid, file_name, file_mode};
    await this.ctx.lnk.insert('cloudfs_files_list', root);
  }

  async is_valid() {
    //check for a valid root mountpoint
    try {
      let line = await this.ctx.row('cloudfs_files_list', ['file_mode = parent_uid', `(${S_IFMT} & file_mode) = ${S_IFDIR}`]);
      if(!line)
        throw `Database is corrupted`;
    } catch(err) {
      return false;
    }

    let user_version = await this.ctx.value(SQL`PRAGMA user_version`);
    if(user_version != schema_version)
      throw `Inconsistent database version, current engine is ${schema_version} vs requested file ${user_version}`;

    return true;
  }

  async warmup() {
    if(this.ctx)
      await this.ctx.close();

    this.ctx = new Context(this.index_path);

    if(!await this.is_valid())
      await this.init_fs(); //re-init all fs

    //now computing all stuffs
    this.entries = await this._compute();
  }


  async _compute() {
    //create inode tree
    let root = {};
    let all = await this.ctx.lnk.select('cloudfs_files_list');

    //first pass, index by guid, find root, setup children
    let entries = {};
    for(let entry of all) {
      entry.children = {};
      if(entry.file_uid == entry.parent_uid)
        root = entry;
      entries[entry.file_uid] = entry;
    }

    //2nd pass, feed parent list
    for(let entry of all) {
      if(entry == root)
        continue;
      let parent = entries[entry.parent_uid];
      parent.children[entry.file_name] = entry;
    }
    return root;
  }

  _computeold_(files, blocks) {
    //file_uid, block_hash, file_name, parent_uid, file_ctime, file_mtime, file_mode
    //entries is a tree of full filepath to all items
    let entries = {};
    blocks = blocks.reduce((acc, block) => (acc[path.basename(block.name)] = block, acc), {});
    let root_guid = guid();

    entries['/'] = {
      file_uid : root_guid, parent_uid : root_guid, file_name : '',
      file_mtime : new Date(),
      file_ctime : new Date(),
      file_size  : 100,
      file_mode  : (S_IFMT & S_IFDIR) | 0o777,
    };

    for(let filepath in files) {
      let block_hash = files[filepath];
      let filepaths = filepath.split('/');

      for(let i = 1; i < filepaths.length; i++) {
        let dirfull = '/' + filepaths.slice(1, i).join('/');
        let parentPath = '/' + filepaths.slice(1, i - 1).join('/');
        if(entries[dirfull])
          continue;
        let parent = entries[parentPath];
        if(!parent)
          throw `No parent '${dirfull}' '${parentPath}' `;

        entries[dirfull] = {
          file_uid : guid(), parent_uid : parent.file_uid, file_name : filepaths[i - 1],
          file_mtime : new Date(),
          file_ctime : new Date(),
          file_size  : 100,
          file_mode  : (S_IFMT & S_IFDIR) | 0o777,
        };
      }

      let parent = entries['/' + filepaths.slice(1, filepaths.length - 1).join('/')];
      if(!parent)
        throw "No parent";

      let block = blocks[block_hash];

      entries[filepath] = {
        file_uid : guid(), parent_uid : parent.file_uid, file_name : filepaths[filepaths.length - 1],
        block_hash,
        file_mtime : new Date(block['last_modified']),
        file_ctime : new Date(block['last_modified']),
        file_size  : block.bytes,
        file_mode : (S_IFMT & S_IFREG) | 0o666,
      };
    }

    //fs.writeFileSync('entries.json', JSON.stringify((entries), null, 2)); process.exit();
    return entries;
  }


  //return false in an entry does not exists
  async _check_entry(file_path) {
    return this._get_entry(file_path).catch(err => {
      if(err == fuse.ENOENT)
        return false;
      throw err;
    });
  }


  async _get_entry(file_path) {
    let node  = this.entries;
    if(file_path == '/')
      return node;

    let paths = file_path.split(path.sep).slice(1); //strip 1st

    for(let part of paths) {
      node = node.children[part];
      if(!node)
        throw fuse.ENOENT;
    }
    return node;
  }


  async create(file_path, mode) {
    console.log('create(%s, %d)', file_path, mode);
    var entry = await this._check_entry(file_path);
    if(entry)
      throw fuse.EEXIST;


    var parent_path = path.dirname(file_path);
    var parent = await this._get_entry(parent_path);
    var block_hash  = EMPTY_MD5;
    var file_name   = path.basename(file_path);
    var data  = {
      file_uid   : guid(),
      file_name,
      parent_uid : parent.file_uid,
      block_hash,
      file_mode  : (S_IFMT & S_IFREG) | 0o666,
    };

    parent.children[file_name] = {...data, children : {}};

    await this.ctx.lnk.insert('cloudfs_files_list', data);
    await this.touch(parent_path);
  }




  async touch(file_path) {
    console.log("touch", file_path);
    var entry = await this._check_entry(file_path);
    if(!entry)
      return await this.create(file_path);

    var now = Math.floor(Date.now() / 1000);
    let data = {file_mtime : now};
    await this.ctx.lnk.update('cloudfs_files_list', data, {file_uid : entry.file_uid});

    //cache management
    update(entry, data);
  }

  async readdir(directory_path) {
    let entry = await this._get_entry(directory_path);

    if((S_IFMT & entry.file_mode) != S_IFDIR)
      throw fuse.ENOTDIR;

    return Object.keys(entry.children);
  }



  async getattr(file_path) {
    console.log("Get getattr", file_path);
    var entry = await this._get_entry(file_path);

    var {file_mode : mode, file_size : size, file_mtime : mtime} = entry;

    var stat = {
      atime : new Date(),
      ctime : mtime,
      mtime, size, mode,
      nlink : 1,

      //https://github.com/billziss-gh/winfsp/issues/40
      uid : 65792, //WD
      gid : 65792,
    };

    return stat;
  }

  async statfs(path) {
    //={Bsize:4096 Frsize:4096 Blocks:274877906944 Bfree:273011914316 Bavail:274877906944 Files:1000000000 Ffree:1000000000 Favail:0 Fsid:0 Flag:0 Namemax:255}
    console.log('statfs(%s)', path);

    let files  = Number(await this.ctx.lnk.value('cloudfs_files_list', true, 'COUNT(*)'));

    console.log('statfs(%s)', path);
    let total = 2; //files.reduce((acc, val) => (acc + val.file_size), 0);

    var bsize = 1000000;
    var max   = 1 * Math.pow(2, 10 + 10 + 10 + 10 + 10); //32 PB
    var blocks = Math.floor(max / bsize);
    var bfree  = Math.floor((max - total) / bsize);
    var statfs = {
      namemax : 255,   /* Maximum length of filenames */
      fsid    : 1000000,  /* Filesystem ID */
      files   : files.length,  /* Total file nodes in filesystem */

      bsize,  /* Optimal transfer block size */
      blocks, /* Total data blocks in filesystem */
      bfree,           /* free blocks  */
      bavail  : bfree,  /* free available blocks */

      frsize  : bsize,   /* Fragment size  */
      ffree   : 1000000,  /* free inodes */
      favail  : 1000000, /* free available inodes */
      flag    : 1000000,   /* Mount flags */
    };

    return statfs;
  }



  async rename(src_path, dest_path) {
    if(src_path == dest_path)
      return;

    let src = await this._get_entry(src_path);

    console.log('rename', src_path, dest_path, src);

    var src_parent = await this._get_entry(path.dirname(src_path));
    var dst_parent = await this._get_entry(path.dirname(dest_path));

    var data = {
      file_name  : path.basename(dest_path),
      parent_uid : dst_parent.file_uid,
    };

    await this.ctx.lnk.update('cloudfs_files_list', data, {file_uid : src.file_uid});

    //cache management
    delete src_parent.children[src.file_name];
    dst_parent.children[data.file_name] = src;
    update(src, data);
    return 0;
  }


  async unlink(file_path) {
    console.log("unlink", file_path);

    var entry = await this._get_entry(file_path);
    if((S_IFMT & entry.file_mode) != S_IFREG)
      throw fuse.EISDIR;

    await this.ctx.lnk.delete('cloudfs_files_list', {file_uid : entry.file_uid});
    await this.touch(path.dirname(file_path));

    //cache management
    var src_parent = await this._get_entry(path.dirname(file_path));
    delete src_parent.children[entry.file_name];
  }

  async rmdir(directory_path) {
    console.log("rmdir", directory_path);
    var entry = await this._get_entry(directory_path);

    if(directory_path == "/")
      throw fuse.EPERM;

    if((S_IFMT & entry.file_mode) != S_IFDIR)
      throw fuse.ENOTDIR;

    if(Object.keys(entry.children).length != 0)
      throw fuse.ENOTEMPTY;

    await this.ctx.lnk.delete('cloudfs_files_list', {file_uid : entry.file_uid});
    await this.touch(path.dirname(directory_path));

    //cache management
    var src_parent = await this._get_entry(path.dirname(directory_path));
    delete src_parent.children[entry.file_name];
  }

  async rmrf(directory_path) {
    console.log("rmrf", directory_path);
    var entry = await this._check_entry(directory_path);
    if(!entry)
      return;

    if(directory_path == "/")
      throw fuse.EPERM;

    //will delete cascade
    await this.ctx.lnk.delete('cloudfs_files_list', {file_uid : entry.file_uid});
    await this.touch(path.dirname(directory_path));

    //cache management
    var src_parent = await this._get_entry(path.dirname(directory_path));
    delete src_parent.children[entry.file_name];
  }


  async mkdirp(directory_path) {
    console.log("mkdirp", directory_path);
    var entry = await this._check_entry(directory_path);
    if(entry) {
      if((S_IFMT & entry.file_mode) != S_IFDIR)
        throw fuse.ENOTDIR;
      return entry;
    } else {
      //make sure parent exists
      await this.mkdirp(path.dirname(directory_path));
      await this.mkdir(directory_path);
    }
  }

  async mkdir(directory_path, mode) {
    console.log("mkdir", directory_path, mode);
    var entry = await this._check_entry(directory_path);
    if(entry)
      throw fuse.EEXIST;

    var parent_path = path.dirname(directory_path);
    var parent = await this._get_entry(parent_path);
    var data  = {
      file_uid   : guid(),
      file_name  : path.basename(directory_path),
      parent_uid : parent.file_uid,
      file_mode  : (S_IFMT & S_IFDIR) | 0o777,
    };

    await this.ctx.lnk.insert('cloudfs_files_list', data);
    await this.touch(parent_path);

    //cache management
    parent.children[data.file_name] = {...data, children : {}};

    return 0;
  }
}



module.exports = Sqlfs;
