//! Sequential stand-in for the subset of rayon used by dcfr-solver.
//! `par_iter` and friends return ordinary std iterators, so `enumerate`, `map`, `for_each`, and `collect`
//! keep their std semantics and results are produced in order on the calling thread.

pub mod prelude {
    pub trait IntoParallelRefIterator<'data> {
        type Iter: Iterator;
        fn par_iter(&'data self) -> Self::Iter;
    }

    impl<'data, T: 'data> IntoParallelRefIterator<'data> for [T] {
        type Iter = std::slice::Iter<'data, T>;
        fn par_iter(&'data self) -> Self::Iter { self.iter() }
    }

    impl<'data, T: 'data> IntoParallelRefIterator<'data> for Vec<T> {
        type Iter = std::slice::Iter<'data, T>;
        fn par_iter(&'data self) -> Self::Iter { self.iter() }
    }

    pub trait IntoParallelRefMutIterator<'data> {
        type Iter: Iterator;
        fn par_iter_mut(&'data mut self) -> Self::Iter;
    }

    impl<'data, T: 'data> IntoParallelRefMutIterator<'data> for [T] {
        type Iter = std::slice::IterMut<'data, T>;
        fn par_iter_mut(&'data mut self) -> Self::Iter { self.iter_mut() }
    }

    impl<'data, T: 'data> IntoParallelRefMutIterator<'data> for Vec<T> {
        type Iter = std::slice::IterMut<'data, T>;
        fn par_iter_mut(&'data mut self) -> Self::Iter { self.iter_mut() }
    }

    pub trait IntoParallelIterator {
        type Iter: Iterator;
        fn into_par_iter(self) -> Self::Iter;
    }

    impl<I: IntoIterator> IntoParallelIterator for I {
        type Iter = I::IntoIter;
        fn into_par_iter(self) -> Self::Iter { self.into_iter() }
    }
}

#[derive(Debug)]
pub struct ThreadPoolBuildError;

impl std::fmt::Display for ThreadPoolBuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("thread pools are not available") }
}

impl std::error::Error for ThreadPoolBuildError {}

/// Accepts the builder calls dcfr-solver makes; there is no pool to configure.
#[derive(Default)]
pub struct ThreadPoolBuilder;

impl ThreadPoolBuilder {
    pub fn new() -> Self { ThreadPoolBuilder }
    pub fn stack_size(self, _bytes: usize) -> Self { self }
    pub fn num_threads(self, _threads: usize) -> Self { self }
    pub fn build_global(self) -> Result<(), ThreadPoolBuildError> { Ok(()) }
}

pub fn current_num_threads() -> usize { 1 }
