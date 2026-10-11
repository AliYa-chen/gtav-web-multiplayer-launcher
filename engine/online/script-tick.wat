;; Owned hook: called after the original engine installs the active script TLS.
;; Import 11 retains its audited (i64, i32) -> i32 ABI; ignore the return value.
local.get 0
i32.const 0x4d505442
call 11
drop
