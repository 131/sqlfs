"use strict";

// make it work, make is fast, make it clean

const fs   = require('fs');
const path = require('path').posix;
const fuse = require('./lib/fuse'); //errors code only
const guid = require('mout/random/guid');
const update = require('mout/object/mixIn');
const ProgressBar = process.env.CI ? class mock { tick() {}} : require('progress');
const md5 = require('nyks/crypto/md5');

const EMPTY_MD5 = md5('');
const debug  = require('debug');
const logger = {
  error : debug('sqlfs:error'),
  info  : debug('sqlfs:info'),
  debug : debug('sqlfs:debug'),
};

const {S_IFMT, S_IFREG, S_IFDIR} = fs.constants; //S_IFCHR, S_IFBLK, S_IFIFO, S_IFLNK, S_IFSOCK
//const {O_RDONLY, O_WRONLY, O_RDWR} = fs.constants;

const schema_version = 20190806;

const OSQLite = require('osqlite'); //or 'osqlite'
const SQL = OSQLite.SQL;

class Sqlfs {

  constructor(index_path, {allow_new} = {allow_new : false}) {
    this.index_path = index_path;
    this.options = {allow_new};
  }

  async _execute(verb, ...args) {
    await this.ctx.lnk[verb]('cloudfs_files_list', ...args);
  }

  serialize(withdir) {
    let files = [];
    let flatten = function(node, paths) {
      let {file_name, file_size, block_hash, file_mode} = node;
      let data = {
        file_path : path.join(paths, file_name),
        file_size, block_hash, file_mode,
      };
      if((S_IFMT & node.file_mode) == S_IFREG || withdir)
        files.push(data);
      for(let filename in node.children || {})
        flatten(node.children[filename], data.file_path);
    };

    flatten(this.entries, "/");
    return files;
  }

  async load(payload, withdir) {
    let token = await this.ctx.lnk.begin();
    logger.info("Loading %d files in current tree", payload.length);
    var bar = new ProgressBar("[:bar] :percent :etas", {total : payload.length, width : 60, incomplete : ' ', clear : true});
    for(let entry of payload) {
      bar.tick(1);
      if((S_IFMT & entry.file_mode) == S_IFREG || withdir || !entry.file_mode)
        await this.register_file(entry.file_path, entry);
    }
    await this.ctx.lnk.commit(token);
  }

  async register_file(file_path, file_data) {
    file_path = path.normalize(file_path);
    await this.mkdirp(path.dirname(file_path));
    let parent = await this._get_entry(path.dirname(file_path));
    var data  = {
      file_uid   : guid(),
      file_name  : path.basename(file_path),
      parent_uid : parent.file_uid,
      block_hash : file_data.block_hash,
      file_size  : file_data.file_size,
      file_mode  : file_data.file_mode || ((S_IFMT & S_IFREG) | 0o666),
    };

    await this._execute('insert', data);
    parent.children[data.file_name] = {...data, children : {}};
  }

  async close() {
    if(this.ctx)
      await this.ctx.close();
  }


  async init_fs() {
    if(this.ctx) {
      await this.ctx.close();
      await this.ctx.destroy();
    }

    this.ctx = OSQLite.build(this.index_path);

    logger.info("New database structure in", this.index_path);
    //create table structure
    await this.ctx.raw(`
     CREATE TABLE cloudfs_files_list (
      file_uid uuid NOT NULL CONSTRAINT cloudfs_files_list_pkey PRIMARY KEY,
      block_hash character varying(32) DEFAULT NULL,
      file_name character varying(128),
      file_size INTEGER NOT NULL DEFAULT 0,
      parent_uid uuid NOT NULL,
      file_ctime REAL DEFAULT (strftime('%s','now')) NOT NULL,
      file_mtime REAL DEFAULT (strftime('%s','now')) NOT NULL,
      file_mode INTEGER NOT NULL,
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
      let line = await this.ctx.row('cloudfs_files_list', ['file_uid = parent_uid', `(${S_IFMT} & file_mode) = ${S_IFDIR}`]);

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

    this.ctx = OSQLite.build(this.index_path);

    let new_db = !await this.is_valid();
    if(new_db) {
      if(!this.options.allow_new)
        throw `Cannot init new database as allow_new options is not set`;

      await this.init_fs(); //re-init all fs
    }

    //now computing all stuffs
    this.entries = await this._compute();

    this.ctx.on("remote_update", async () => {
      console.log("Got remote update order, recompute everything");
      this.entries = await this._compute();
    });

    return new_db;
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

  //return false in an entry does not exists
  async _check_entry(file_path) {
    return this._get_entry(file_path).catch(err => {
      if(err == fuse.ENOENT)
        return false;
      throw err;
    });
  }


  async _get_entry(file_path) {
    file_path = path.normalize(file_path);
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
    file_path = path.normalize(file_path);
    logger.debug('create(%s, %d)', file_path, mode);
    var entry = await this._check_entry(file_path);
    if(entry)
      throw fuse.EEXIST;


    var parent_path = path.dirname(file_path);
    var parent = await this._get_entry(parent_path);
    var file_name   = path.basename(file_path);
    var data  = {
      file_uid   : guid(),
      file_name,
      parent_uid : parent.file_uid,
      block_hash : EMPTY_MD5,
      file_size  : 0,
      file_mode  : (S_IFMT & S_IFREG) | 0o666,
    };

    await this._execute('insert', data); //no await
    parent.children[file_name] = {...data, children : {}};

    await this.touch(parent_path);
  }

  async update(entry, data) {
    await this._execute('update', data, {file_uid : entry.file_uid});
    update(entry, data);
  }

  async utimens(file_path, atime, mtime) {
    logger.debug("utimens", file_path, atime, mtime);
    var entry = await this._get_entry(file_path);
    await this.update(entry, {file_mtime : mtime / 1000});
  }


  async touch(file_path) {
    logger.debug("touch", file_path);
    var entry = await this._check_entry(file_path);
    if(!entry)
      return await this.create(file_path);

    await this.update(entry, {file_mtime : Date.now() / 1000});
  }

  async readdir(directory_path) {
    let entry = await this._get_entry(directory_path);

    if((S_IFMT & entry.file_mode) != S_IFDIR)
      throw fuse.ENOTDIR;

    return Object.keys(entry.children);
  }


  async getattr(file_path) {
    logger.debug("Get getattr", file_path);
    var entry = await this._get_entry(file_path);

    var {file_mode : mode, file_size : size, file_mtime : mtime, file_ctime : ctime} = entry;

    var stat = {
      atime : new Date(),
      ctime : ctime * 1000,
      mtime : mtime * 1000,
      size, mode,
      nlink : 1,

      //https://github.com/billziss-gh/winfsp/issues/40
      uid : 65792, //WD
      gid : 65792,
    };

    return stat;
  }

  async statfs(path) {
    //={Bsize:4096 Frsize:4096 Blocks:274877906944 Bfree:273011914316 Bavail:274877906944 Files:1000000000 Ffree:1000000000 Favail:0 Fsid:0 Flag:0 Namemax:255}
    logger.debug('statfs(%s)', path);

    let files  = Number(await this.ctx.lnk.value('cloudfs_files_list', true, 'COUNT(*)'));

    logger.debug('statfs(%s)', path);
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
    logger.debug('rename', src_path, dest_path);

    if(src_path == dest_path)
      return;

    let src = await this._get_entry(src_path);

    var src_parent = await this._get_entry(path.dirname(src_path));
    var dst_parent = await this._get_entry(path.dirname(dest_path));

    let dst = await this._check_entry(dest_path);
    if(dst) {
      if((S_IFMT & src.file_mode) == S_IFREG) {
        if((S_IFMT & dst.file_mode) == S_IFREG) {
          //source and remote are files, should unlink dest first
          await this._execute('delete', {file_uid : dst.file_uid});
        }
      }
    }

    delete src_parent.children[src.file_name];
    await this.update(src, {
      file_name  : path.basename(dest_path),
      parent_uid : dst_parent.file_uid,
    });
    dst_parent.children[src.file_name] = src;
    return 0;
  }


  async unlink(file_path) {
    logger.debug("unlink", file_path);

    var entry = await this._get_entry(file_path);
    if((S_IFMT & entry.file_mode) != S_IFREG)
      throw fuse.EISDIR;

    var src_parent = await this._get_entry(path.dirname(file_path));

    await this._execute('delete', {file_uid : entry.file_uid});
    delete src_parent.children[entry.file_name];
    await this.touch(path.dirname(file_path));
  }

  async rmdir(directory_path) {
    logger.debug("rmdir", directory_path);
    var entry = await this._get_entry(directory_path);

    if(directory_path == "/")
      throw fuse.EPERM;

    if((S_IFMT & entry.file_mode) != S_IFDIR)
      throw fuse.ENOTDIR;

    if(Object.keys(entry.children).length != 0)
      throw fuse.ENOTEMPTY;

    var src_parent = await this._get_entry(path.dirname(directory_path));

    await this._execute('delete', {file_uid : entry.file_uid});
    delete src_parent.children[entry.file_name];
    await this.touch(path.dirname(directory_path));
  }

  async rmrf(directory_path) {
    logger.debug("rmrf", directory_path);
    var entry = await this._check_entry(directory_path);
    if(!entry)
      return;

    if(directory_path == "/")
      throw fuse.EPERM;

    var src_parent = await this._get_entry(path.dirname(directory_path));

    //will delete cascade
    await this._execute('delete', {file_uid : entry.file_uid});
    delete src_parent.children[entry.file_name];
    await this.touch(path.dirname(directory_path));
  }


  async mkdirp(directory_path) {
    directory_path = path.normalize(directory_path);
    logger.debug("mkdirp", directory_path);
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
    logger.debug("mkdir", directory_path, mode);
    var entry = await this._check_entry(directory_path);
    if(entry)
      throw fuse.EEXIST;

    var parent_path = path.dirname(directory_path);
    var parent = await this._get_entry(parent_path);
    var data  = {
      file_uid   : guid(),
      file_name  : path.basename(directory_path),
      parent_uid : parent.file_uid,
      file_size  : 0,
      block_hash : null,
      file_mode  : (S_IFMT & S_IFDIR) | 0o777,
    };

    await this._execute('insert', data);
    parent.children[data.file_name] = {...data, children : {}};

    await this.touch(parent_path);
    return 0;
  }
}



module.exports = Sqlfs;
