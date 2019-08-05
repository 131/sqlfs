[![Build Status](https://travis-ci.org/131/sqlfs.svg?branch=master)](https://travis-ci.org/131/sqlfs)
[![Coverage Status](https://coveralls.io/repos/github/131/sqlfs/badge.svg?branch=master)](https://coveralls.io/github/131/sqlfs?branch=master)
[![Version](https://img.shields.io/npm/v/sqlitefs.svg)](https://www.npmjs.com/package/sqlitefs)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](http://opensource.org/licenses/MIT)
[![Code style](https://img.shields.io/badge/code%2fstyle-ivs-green.svg)](https://www.npmjs.com/package/eslint-plugin-ivs)
![Available platform](https://img.shields.io/badge/platform-win32-blue.svg) ![Available platform](https://img.shields.io/badge/platform-linux-blue.svg)

# Motivation

[sqlfs](https://github.com/131/sqlfs) is a POSIX compliant inode table to be used as [fuse binding](https://github.com/mafintosh/fuse-bindings) engine. Inode table is store in a very simple [sqlite](https://www.npmjs.com/package/@131/sqlite3) file.

[sqlfs](https://github.com/131/sqlfs) is the underlying inode table that support the [cloudfs](https://github.com/131/cloudfs) project.

# Main features
* Simple by design
* Available on all platforms (linux & Windows)
* Very fast (sqlite is actually fastest than most file system)
* Strongly tested
* [sqlfs](https://github.com/131/sqlfs) load the whole inode table in memory and use about 1k per file of inode data. So having 100k file will use at least 100MB of memory.

# Supported API
[sqlfs](https://github.com/131/sqlfs) support most of the [fuse](https://github.com/mafintosh/fuse-bindings) API (appart for file body access - open, release, read, write - see cloudfs for this part)

- `gettattr`
- `mkdir`
- `readdir`
- `rename`
- `rmdir`
- `statfs`
- `unlink`
- `touch` / `create`


# inode table design

| file_uid   | file_name | parent_uid      | file_type | file_size | block_hash | file_ctime | file_mtime |
| ---        | ---       | ---             | ---       | ---       | ---        | ---        | ---        |
| (someguid) | usr       | (someotherguid) | directory | 0         | *null*     | 1560000505 | 1560000505 |
| (someguid) | "foo"     | (someotherguid) | file      | 2323      | (file md5) | 1560000505 | 1560000505 |


# Credits
* [131 - author](https://github.com/131)
* [mafintosh' fuse-bindings](https://github.com/mafintosh/fuse-bindings)

