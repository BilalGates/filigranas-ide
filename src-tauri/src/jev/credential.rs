// The credential is provisioned in the OS vault, outside the webview.
pub const SERVICE: &str = "Filigranas IDE TypeSafe";
pub const ACCOUNT: &str = "jev";

#[cfg(target_os = "macos")]
pub fn read(interactive: bool) -> Option<String> {
    use std::{ffi::c_void, ptr, slice};
    type Cf = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(allocator: Cf, bytes: *const u8, len: isize, encoding: u32, external: u8) -> Cf;
        fn CFDictionaryCreate(allocator: Cf, keys: *const Cf, values: *const Cf, len: isize, key_callbacks: Cf, value_callbacks: Cf) -> Cf;
        fn CFDataGetLength(data: Cf) -> isize;
        fn CFDataGetBytePtr(data: Cf) -> *const u8;
        fn CFRelease(value: Cf);
        static kCFBooleanTrue: Cf;
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
    }

    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecItemCopyMatching(query: Cf, result: *mut Cf) -> i32;
        static kSecClass: Cf;
        static kSecClassGenericPassword: Cf;
        static kSecAttrService: Cf;
        static kSecAttrAccount: Cf;
        static kSecReturnData: Cf;
        static kSecUseAuthenticationUI: Cf;
        static kSecUseAuthenticationUIFail: Cf;
    }

    // All dictionary entries stay alive through the call. ReturnData with the
    // default single match returns an owned CFData when the status is success.
    unsafe {
        let make_string = |s: &str| CFStringCreateWithBytes(ptr::null(), s.as_ptr(), s.len() as isize, 0x0800_0100, 0);
        let service = make_string(SERVICE);
        let account = make_string(ACCOUNT);
        let keys = [kSecClass, kSecAttrService, kSecAttrAccount, kSecReturnData, kSecUseAuthenticationUI];
        let values = [kSecClassGenericPassword, service, account, kCFBooleanTrue, kSecUseAuthenticationUIFail];
        let len = if interactive { 4 } else { 5 };
        let query = if service.is_null() || account.is_null() {
            ptr::null()
        } else {
            CFDictionaryCreate(ptr::null(), keys.as_ptr(), values.as_ptr(), len,
                ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(),
                ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast())
        };
        let mut data = ptr::null();
        let status = if query.is_null() { -1 } else { SecItemCopyMatching(query, &mut data) };
        for cf in [query, service, account].into_iter().filter(|cf| !cf.is_null()) {
            CFRelease(cf);
        }
        if status != 0 || data.is_null() {
            return None;
        }
        let len = CFDataGetLength(data);
        let key = if (1..=2048).contains(&len) {
            std::str::from_utf8(slice::from_raw_parts(CFDataGetBytePtr(data), len as usize)).ok().map(str::to_owned)
        } else {
            None
        };
        CFRelease(data);
        key
    }
}

#[cfg(windows)]
pub fn read(_: bool) -> Option<String> {
    use std::{ffi::c_void, ptr, slice};

    // wincred.h CREDENTIALW, including FILETIME (two DWORDs).
    #[repr(C)]
    struct Credential {
        flags: u32,
        typ: u32,
        target: *mut u16,
        comment: *mut u16,
        last_written: [u32; 2],
        size: u32,
        blob: *mut u8,
        persist: u32,
        attribute_count: u32,
        attributes: *mut c_void,
        alias: *mut u16,
        username: *mut u16,
    }

    #[link(name = "Advapi32")]
    extern "system" {
        fn CredReadW(target: *const u16, typ: u32, flags: u32, result: *mut *mut Credential) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    let target: Vec<u16> = SERVICE.encode_utf16().chain([0]).collect();
    let mut credential = ptr::null_mut();
    // The OS vault UI stores its generic password as UTF-16LE bytes.
    unsafe {
        if CredReadW(target.as_ptr(), 1, 0, &mut credential) == 0 || credential.is_null() {
            return None;
        }
        let entry = &*credential;
        let secret = if (2..=4096).contains(&entry.size) && !entry.blob.is_null() {
            let data = slice::from_raw_parts(entry.blob, entry.size as usize);
            let mut characters = data.chunks_exact(2);
            let wide: Vec<u16> = characters.by_ref().map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            if characters.remainder().is_empty() {
                String::from_utf16(wide.strip_suffix(&[0]).unwrap_or(&wide)).ok()
            } else {
                None
            }
        } else {
            None
        };
        CredFree(credential.cast());
        secret
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn read(_: bool) -> Option<String> {
    None
}
