(module
 (type $0 (func (result i32)))
 (type $1 (func (param i32 i32) (result i32)))
 (type $2 (func (param i32 i32 i32)))
 (type $3 (func (param i32) (result i32)))
 (type $4 (func))
 (type $5 (func (param i32 i32 i32 i32)))
 (import "env" "abort" (func $~lib/builtins/abort (param i32 i32 i32 i32)))
 (global $~lib/rt/stub/offset (mut i32) (i32.const 0))
 (global $wasm-src/index/left (mut i32) (i32.const 0))
 (global $wasm-src/index/inBuf (mut i32) (i32.const 0))
 (global $wasm-src/index/outBuf (mut i32) (i32.const 0))
 (global $wasm-src/index/lenBuf (mut i32) (i32.const 0))
 (global $wasm-src/index/leftLen (mut i32) (i32.const 0))
 (memory $0 1)
 (data $0 (i32.const 1036) ",")
 (data $0.1 (i32.const 1048) "\02\00\00\00\1c\00\00\00I\00n\00v\00a\00l\00i\00d\00 \00l\00e\00n\00g\00t\00h")
 (data $1 (i32.const 1084) "<")
 (data $1.1 (i32.const 1096) "\02\00\00\00&\00\00\00~\00l\00i\00b\00/\00s\00t\00a\00t\00i\00c\00a\00r\00r\00a\00y\00.\00t\00s")
 (data $2 (i32.const 1148) "<")
 (data $2.1 (i32.const 1160) "\02\00\00\00(\00\00\00A\00l\00l\00o\00c\00a\00t\00i\00o\00n\00 \00t\00o\00o\00 \00l\00a\00r\00g\00e")
 (data $3 (i32.const 1212) "<")
 (data $3.1 (i32.const 1224) "\02\00\00\00\1e\00\00\00~\00l\00i\00b\00/\00r\00t\00/\00s\00t\00u\00b\00.\00t\00s")
 (data $4 (i32.const 1276) "<")
 (data $4.1 (i32.const 1288) "\02\00\00\00$\00\00\00I\00n\00d\00e\00x\00 \00o\00u\00t\00 \00o\00f\00 \00r\00a\00n\00g\00e")
 (export "version" (func $wasm-src/index/version))
 (export "inPtr" (func $wasm-src/index/inPtr))
 (export "outPtr" (func $wasm-src/index/outPtr))
 (export "lenPtr" (func $wasm-src/index/lenPtr))
 (export "inCap" (func $wasm-src/index/inCap))
 (export "outCap" (func $wasm-src/index/outCap))
 (export "maxLines" (func $wasm-src/index/maxLines))
 (export "leftCap" (func $wasm-src/index/leftCap))
 (export "pending" (func $wasm-src/index/pending))
 (export "reset" (func $wasm-src/index/reset))
 (export "feed" (func $wasm-src/index/feed))
 (export "flush" (func $wasm-src/index/flush))
 (export "hash" (func $wasm-src/index/hash))
 (export "memory" (memory $0))
 (start $~start)
 (func $~lib/staticarray/StaticArray<u8>#__get (param $0 i32) (param $1 i32) (result i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.ge_u
  if
   i32.const 1296
   i32.const 1104
   i32.const 78
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.add
  i32.load8_u
 )
 (func $~lib/staticarray/StaticArray<u8>#__set (param $0 i32) (param $1 i32) (param $2 i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.ge_u
  if
   i32.const 1296
   i32.const 1104
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.add
  local.get $2
  i32.store8
 )
 (func $~lib/staticarray/StaticArray<u8>#constructor (param $0 i32) (result i32)
  (local $1 i32)
  local.get $0
  i32.const 1073741820
  i32.gt_u
  if
   i32.const 1056
   i32.const 1104
   i32.const 51
   i32.const 60
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  i32.const 4
  call $~lib/rt/stub/__new
  local.tee $1
  i32.const 0
  local.get $0
  memory.fill
  local.get $1
 )
 (func $~lib/staticarray/StaticArray<i32>#__set (param $0 i32) (param $1 i32) (param $2 i32)
  local.get $1
  local.get $0
  i32.const 20
  i32.sub
  i32.load offset=16
  i32.const 2
  i32.shr_u
  i32.ge_u
  if
   i32.const 1296
   i32.const 1104
   i32.const 93
   i32.const 41
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  local.get $1
  i32.const 2
  i32.shl
  i32.add
  local.get $2
  i32.store
 )
 (func $~lib/rt/stub/__new (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $0
  i32.const 1073741804
  i32.gt_u
  if
   i32.const 1168
   i32.const 1232
   i32.const 86
   i32.const 30
   call $~lib/builtins/abort
   unreachable
  end
  local.get $0
  i32.const 16
  i32.add
  local.tee $3
  i32.const 1073741820
  i32.gt_u
  if
   i32.const 1168
   i32.const 1232
   i32.const 33
   i32.const 29
   call $~lib/builtins/abort
   unreachable
  end
  global.get $~lib/rt/stub/offset
  i32.const 4
  i32.add
  local.tee $2
  local.get $3
  i32.const 19
  i32.add
  i32.const -16
  i32.and
  i32.const 4
  i32.sub
  local.tee $3
  i32.add
  local.tee $4
  memory.size
  local.tee $5
  i32.const 16
  i32.shl
  i32.const 15
  i32.add
  i32.const -16
  i32.and
  local.tee $6
  i32.gt_u
  if
   local.get $5
   local.get $4
   local.get $6
   i32.sub
   i32.const 65535
   i32.add
   i32.const -65536
   i32.and
   i32.const 16
   i32.shr_u
   local.tee $6
   local.get $5
   local.get $6
   i32.gt_s
   select
   memory.grow
   i32.const 0
   i32.lt_s
   if
    local.get $6
    memory.grow
    i32.const 0
    i32.lt_s
    if
     unreachable
    end
   end
  end
  global.get $~lib/rt/stub/offset
  local.get $4
  global.set $~lib/rt/stub/offset
  local.get $3
  i32.store
  local.get $2
  i32.const 4
  i32.sub
  local.tee $3
  i32.const 0
  i32.store offset=4
  local.get $3
  i32.const 0
  i32.store offset=8
  local.get $3
  local.get $1
  i32.store offset=12
  local.get $3
  local.get $0
  i32.store offset=16
  local.get $2
  i32.const 16
  i32.add
 )
 (func $~start
  (local $0 i32)
  i32.const 1340
  global.set $~lib/rt/stub/offset
  i32.const 262144
  call $~lib/staticarray/StaticArray<u8>#constructor
  global.set $wasm-src/index/left
  i32.const 65536
  call $~lib/staticarray/StaticArray<u8>#constructor
  global.set $wasm-src/index/inBuf
  i32.const 327680
  call $~lib/staticarray/StaticArray<u8>#constructor
  global.set $wasm-src/index/outBuf
  i32.const 32768
  i32.const 5
  call $~lib/rt/stub/__new
  local.tee $0
  i32.const 0
  i32.const 32768
  memory.fill
  local.get $0
  global.set $wasm-src/index/lenBuf
 )
 (func $wasm-src/index/version (result i32)
  i32.const 2
 )
 (func $wasm-src/index/reset
  i32.const 0
  global.set $wasm-src/index/leftLen
 )
 (func $wasm-src/index/pending (result i32)
  global.get $wasm-src/index/leftLen
 )
 (func $wasm-src/index/outPtr (result i32)
  global.get $wasm-src/index/outBuf
 )
 (func $wasm-src/index/outCap (result i32)
  i32.const 327680
 )
 (func $wasm-src/index/maxLines (result i32)
  i32.const 8192
 )
 (func $wasm-src/index/lenPtr (result i32)
  global.get $wasm-src/index/lenBuf
 )
 (func $wasm-src/index/leftCap (result i32)
  i32.const 262144
 )
 (func $wasm-src/index/inPtr (result i32)
  global.get $wasm-src/index/inBuf
 )
 (func $wasm-src/index/inCap (result i32)
  i32.const 65536
 )
 (func $wasm-src/index/hash (param $0 i32) (param $1 i32) (result i32)
  (local $2 i32)
  (local $3 i32)
  i32.const -2128831035
  local.set $2
  loop $for-loop|0
   local.get $1
   local.get $3
   i32.gt_s
   if
    local.get $2
    local.get $0
    local.get $3
    i32.add
    i32.load8_u
    i32.xor
    i32.const 16777619
    i32.mul
    local.set $2
    local.get $3
    i32.const 1
    i32.add
    local.set $3
    br $for-loop|0
   end
  end
  local.get $2
 )
 (func $wasm-src/index/flush (result i32)
  (local $0 i32)
  (local $1 i32)
  global.get $wasm-src/index/leftLen
  i32.const 0
  i32.le_s
  if
   i32.const 0
   return
  end
  i32.const 327680
  global.get $wasm-src/index/leftLen
  global.get $wasm-src/index/leftLen
  i32.const 327680
  i32.gt_s
  select
  local.set $1
  loop $for-loop|0
   local.get $0
   local.get $1
   i32.lt_s
   if
    global.get $wasm-src/index/outBuf
    local.get $0
    global.get $wasm-src/index/left
    local.get $0
    call $~lib/staticarray/StaticArray<u8>#__get
    call $~lib/staticarray/StaticArray<u8>#__set
    local.get $0
    i32.const 1
    i32.add
    local.set $0
    br $for-loop|0
   end
  end
  global.get $wasm-src/index/lenBuf
  i32.const 0
  local.get $1
  call $~lib/staticarray/StaticArray<i32>#__set
  i32.const 0
  global.set $wasm-src/index/leftLen
  local.get $1
 )
 (func $wasm-src/index/feed (param $0 i32) (result i32)
  (local $1 i32)
  (local $2 i32)
  (local $3 i32)
  (local $4 i32)
  (local $5 i32)
  (local $6 i32)
  local.get $0
  i32.const 0
  i32.lt_s
  local.get $0
  i32.const 65536
  i32.gt_s
  i32.or
  if
   i32.const -1
   return
  end
  global.get $wasm-src/index/leftLen
  local.get $0
  i32.add
  i32.const 262144
  i32.gt_s
  if
   i32.const -2
   return
  end
  loop $for-loop|0
   local.get $0
   local.get $1
   i32.gt_s
   if
    global.get $wasm-src/index/left
    global.get $wasm-src/index/leftLen
    local.get $1
    i32.add
    global.get $wasm-src/index/inBuf
    local.get $1
    call $~lib/staticarray/StaticArray<u8>#__get
    call $~lib/staticarray/StaticArray<u8>#__set
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|0
   end
  end
  global.get $wasm-src/index/leftLen
  local.get $0
  i32.add
  local.set $4
  i32.const 0
  local.set $0
  i32.const 0
  local.set $1
  loop $for-loop|1
   local.get $1
   local.get $4
   i32.lt_s
   if
    block $for-break1
     global.get $wasm-src/index/left
     local.get $1
     call $~lib/staticarray/StaticArray<u8>#__get
     i32.const 10
     i32.eq
     if
      local.get $6
      local.get $1
      i32.const 1
      i32.sub
      local.tee $2
      local.get $1
      local.get $0
      local.get $1
      i32.lt_s
      if (result i32)
       global.get $wasm-src/index/left
       local.get $2
       call $~lib/staticarray/StaticArray<u8>#__get
       i32.const 13
       i32.eq
      else
       i32.const 0
      end
      select
      local.get $0
      i32.sub
      local.tee $5
      i32.add
      i32.const 327680
      i32.gt_s
      local.get $3
      i32.const 8192
      i32.ge_s
      i32.or
      br_if $for-break1
      i32.const 0
      local.set $2
      loop $for-loop|2
       local.get $2
       local.get $5
       i32.lt_s
       if
        global.get $wasm-src/index/outBuf
        local.get $2
        local.get $6
        i32.add
        global.get $wasm-src/index/left
        local.get $0
        local.get $2
        i32.add
        call $~lib/staticarray/StaticArray<u8>#__get
        call $~lib/staticarray/StaticArray<u8>#__set
        local.get $2
        i32.const 1
        i32.add
        local.set $2
        br $for-loop|2
       end
      end
      global.get $wasm-src/index/lenBuf
      local.get $3
      local.get $5
      call $~lib/staticarray/StaticArray<i32>#__set
      local.get $5
      local.get $6
      i32.add
      local.set $6
      local.get $3
      i32.const 1
      i32.add
      local.set $3
      local.get $1
      i32.const 1
      i32.add
      local.set $0
     end
     local.get $1
     i32.const 1
     i32.add
     local.set $1
     br $for-loop|1
    end
   end
  end
  local.get $0
  local.set $1
  loop $for-loop|3
   local.get $1
   local.get $4
   i32.lt_s
   if
    global.get $wasm-src/index/left
    local.get $1
    local.get $0
    i32.sub
    global.get $wasm-src/index/left
    local.get $1
    call $~lib/staticarray/StaticArray<u8>#__get
    call $~lib/staticarray/StaticArray<u8>#__set
    local.get $1
    i32.const 1
    i32.add
    local.set $1
    br $for-loop|3
   end
  end
  local.get $4
  local.get $0
  i32.sub
  global.set $wasm-src/index/leftLen
  local.get $3
 )
)
