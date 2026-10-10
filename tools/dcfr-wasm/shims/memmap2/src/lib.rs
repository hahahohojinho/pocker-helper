//! Heap-backed stand-in for the anonymous `MmapMut` used by dcfr-solver's regret arena.

/// Zero-initialized buffer with 8-byte alignment, matching what the arena casts the pointer to.
pub struct MmapMut {
    words: Vec<u64>,
    len: usize,
}

impl MmapMut {
    pub fn map_anon(len: usize) -> std::io::Result<MmapMut> {
        let mut words = Vec::new();
        words.try_reserve_exact(len.div_ceil(8)).map_err(|_| std::io::Error::new(std::io::ErrorKind::OutOfMemory, "regret arena allocation failed"))?;
        words.resize(len.div_ceil(8), 0);
        Ok(MmapMut { words, len })
    }

    pub fn len(&self) -> usize { self.len }
    pub fn is_empty(&self) -> bool { self.len == 0 }
    pub fn as_ptr(&self) -> *const u8 { self.words.as_ptr() as *const u8 }
    pub fn as_mut_ptr(&mut self) -> *mut u8 { self.words.as_mut_ptr() as *mut u8 }
}
