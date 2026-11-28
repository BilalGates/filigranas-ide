// The credential is provisioned in the OS vault, outside the webview.
pub const SERVICE: &str = "Filigranas IDE TypeSafe";
pub const ACCOUNT: &str = "jev";

#[cfg(target_os = "macos")]
fn read_macos(service_name: &str, interactive: bool) -> Option<String> {
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
        let service = make_string(service_name);
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
fn read_windows(service_name: &str) -> Option<String> {
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

    let target: Vec<u16> = service_name.encode_utf16().chain([0]).collect();
    let mut credential = ptr::null_mut();
    // The OS vault UI stores its generic password as UTF-16LE bytes.
    unsafe {
        if CredReadW(target.as_ptr(), 1, 0, &mut credential) == 0 || credential.is_null() {
            return None;
        }
        let entry = &*credential;
        let secret = if (2..=4096).contains(&entry.size) && !entry.blob.is_null() {
            let data = slice::from_raw_parts(entry.blob, entry.size as usize);
            let (characters, remainder) = data.as_chunks::<2>();
            let wide: Vec<u16> = characters.iter().map(|c| u16::from_le_bytes(*c)).collect();
            if remainder.is_empty() {
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

pub fn read(interactive: bool) -> Option<String> {
    #[cfg(target_os = "macos")]
    { read_macos(SERVICE,interactive) }
    #[cfg(windows)]
    { let _ = interactive; read_windows(SERVICE) }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = interactive; None }
}

/// No shell, environment variable, argument vector or database receives the key.
#[cfg(target_os = "macos")]
mod write_macos {
    use std::{ffi::c_void, ptr};
    type Cf = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(a: Cf, b: *const u8, n: isize, encoding: u32, external: u8) -> Cf;
        fn CFDataCreate(a: Cf, b: *const u8, n: isize) -> Cf;
        fn CFDictionaryCreate(a: Cf, k: *const Cf, v: *const Cf, n: isize, kc: Cf, vc: Cf) -> Cf;
        fn CFRelease(v: Cf);
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
    }
    #[link(name = "Security", kind = "framework")]
    extern "C" {
        fn SecItemAdd(q: Cf, result: *mut Cf) -> i32;
        fn SecItemUpdate(q: Cf, attrs: Cf) -> i32;
        fn SecItemDelete(q: Cf) -> i32;
        static kSecClass: Cf;
        static kSecClassGenericPassword: Cf;
        static kSecAttrService: Cf;
        static kSecAttrAccount: Cf;
        static kSecValueData: Cf;
    }
    unsafe fn dictionary(keys: &[Cf], values: &[Cf]) -> Cf {
        CFDictionaryCreate(ptr::null(), keys.as_ptr(), values.as_ptr(), keys.len() as isize,
            ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(), ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast())
    }
    pub fn change(service_name: &str, key: Option<&str>) -> Result<(), String> {
        // CF objects are owned until all Security calls complete. New items get
        // the calling application's default Keychain access, never an all-app ACL.
        unsafe {
            let string = |s: &str| CFStringCreateWithBytes(ptr::null(), s.as_ptr(), s.len() as isize, 0x0800_0100, 0);
            let service = string(service_name);
            let account = string(super::ACCOUNT);
            let keys = [kSecClass, kSecAttrService, kSecAttrAccount];
            let vals = [kSecClassGenericPassword, service, account];
            let query = dictionary(&keys, &vals);
            let mut owned = vec![query, service, account];
            let status = if let Some(key) = key {
                let data = CFDataCreate(ptr::null(), key.as_ptr(), key.len() as isize);
                let attrs = dictionary(&[kSecValueData], &[data]);
                owned.extend([data, attrs]);
                let status = SecItemUpdate(query, attrs);
                if status == -25300 {
                    let add = dictionary(&[kSecClass,kSecAttrService,kSecAttrAccount,kSecValueData], &[kSecClassGenericPassword,service,account,data]);
                    owned.push(add);
                    SecItemAdd(add, ptr::null_mut())
                } else { status }
            } else { SecItemDelete(query) };
            for value in owned.into_iter().filter(|v| !v.is_null()) { CFRelease(value); }
            if status == 0 || (key.is_none() && status == -25300) { Ok(()) }
            else { Err(format!("Keychain no pudo actualizar la credencial personal (OSStatus {status}). Autoriza el acceso nativo de macOS si lo solicita.")) }
        }
    }
}

#[cfg(windows)]
mod write_windows {
    use std::{ffi::c_void, ptr};
    #[repr(C)]
    struct Credential {
        flags: u32, typ: u32, target: *mut u16, comment: *mut u16,
        last_written: [u32;2], size: u32, blob: *mut u8, persist: u32,
        attribute_count: u32, attributes: *mut c_void, alias: *mut u16, username: *mut u16,
    }
    #[link(name = "Advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
        fn CredDeleteW(target: *const u16, typ: u32, flags: u32) -> i32;
    }
    pub fn change(service_name: &str, key: Option<&str>) -> Result<(), String> {
        let mut target: Vec<_> = service_name.encode_utf16().chain([0]).collect();
        let mut account: Vec<_> = super::ACCOUNT.encode_utf16().chain([0]).collect();
        let result = unsafe {
            if let Some(key) = key {
                let mut blob: Vec<u8> = key.encode_utf16().flat_map(u16::to_le_bytes).collect();
                let entry = Credential { flags:0, typ:1, target:target.as_mut_ptr(), comment:ptr::null_mut(),
                    last_written:[0,0], size:blob.len() as u32, blob:blob.as_mut_ptr(), persist:2,
                    attribute_count:0, attributes:ptr::null_mut(), alias:ptr::null_mut(), username:account.as_mut_ptr() };
                CredWriteW(&entry,0)
            } else { CredDeleteW(target.as_ptr(),1,0) }
        };
        if result != 0 || (key.is_none() && std::io::Error::last_os_error().raw_os_error() == Some(1168)) { Ok(()) }
        else { Err("El Administrador de credenciales no pudo actualizar la clave personal.".into()) }
    }
}

pub fn save(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 2048 || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b)) {
        return Err("Formato de credencial no válido".into());
    }
    change(Some(key))
}
pub fn delete() -> Result<(), String> { change(None) }
fn change(key: Option<&str>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    { write_macos::change(SERVICE,key) }
    #[cfg(windows)]
    { write_windows::change(SERVICE,key) }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = key; Err("Almacén seguro no disponible en esta plataforma".into()) }
}

#[cfg(all(test,target_os="macos"))]
mod tests {
    use super::*;
    #[test]
    #[ignore = "writes only a unique disposable Keychain item; never the personal credential"]
    fn real_keychain_roundtrip() {
        let service = format!("Filigranas P0 fixture {}",uuid::Uuid::new_v4());
        assert!(read_macos(&service,false).is_none());
        write_macos::change(&service,Some("fixture-key-first")).unwrap();
        let first = read_macos(&service,false);
        write_macos::change(&service,Some("fixture-key-replaced")).unwrap();
        let replaced = read_macos(&service,false);
        write_macos::change(&service,None).unwrap();
        let deleted = read_macos(&service,false);
        assert!(first.as_deref()==Some("fixture-key-first"));
        assert!(replaced.as_deref()==Some("fixture-key-replaced"));
        assert!(deleted.is_none());
        println!("KEYCHAIN_ROUNDTRIP fresh_absent=true save=true replace=true delete=true personal_key_untouched=true");
    }
}
