//! Measures dcfr-solver's per-node overhead and compares it with the pre-solve estimate.
use dcfr_solver::cfr::SubgameSolver;

fn main() {
    let wide = "AA,KK,QQ,JJ,TT,99,88,77,66,55,44,33,22,AKs,AQs,AJs,ATs,A9s,A8s,A7s,A6s,A5s,A4s,A3s,A2s,KQs,KJs,KTs,K9s,K8s,K7s,K6s,K5s,QJs,QTs,Q9s,Q8s,JTs,J9s,J8s,T9s,T8s,98s,97s,87s,86s,76s,75s,65s,54s,AKo,AQo,AJo,ATo,A9o,A8o,KQo,KJo,KTo,QJo,QTo,JTo";
    let spots = [
        ("JsTd7c", wide, wide, "[[[1,2]],[[3,5]]]", 2, 9750),
        ("JsTd7c", wide, wide, "[[[1,3],[3,4],[3,2]],[[3,5],[1,1]]]", 3, 9750),
        ("JsTd7c", "AsQh", "KsKh", "[[[1,3],[3,4],[3,2]],[[3,5],[1,1]]]", 3, 9750),
        ("JsTd7c", "AsQh", "KsKh", "[[[1,2]],[[3,5]]]", 2, 650),
    ];
    for (board, oop, ip, sizes, max_raises, stack) in spots {
        let json = format!(r#"{{"board":"{board}","hero":"AsQh","oopRange":"{oop}","ipRange":"{ip}","pot":650,"stacks":[{stack},{stack}],"iterations":1,"betSizes":{sizes},"maxRaises":{max_raises}}}"#);
        let request = rangelab_dcfr_core::SolveRequest::parse(&json).unwrap();
        let estimate = rangelab_dcfr_core::estimate(&request, u64::MAX).unwrap();
        let mut solver = SubgameSolver::new(rangelab_dcfr_core::subgame_config_for(&request));
        solver.solve();
        let m = solver.memory_breakdown();
        let nodes = m.decision_count + m.chance_count + m.terminal_count;
        let overhead = m.cfr_overhead + m.tree_bytes + m.node_index_bytes + m.iso_perm_bytes;
        let total = m.regrets_bytes + m.cum_strategy_bytes + overhead + m.sd_cache_bytes;
        println!("{oop} vs {ip} raises={max_raises} stack={stack}: nodes est {} act {} | overhead/node {:.0}B (cfr {} tree {} index {} iso {}) sd_cache {}MB | total act {:.1}MB est {:.1}MB",
            estimate.tree_nodes, nodes, overhead as f64 / nodes as f64, m.cfr_overhead, m.tree_bytes, m.node_index_bytes, m.iso_perm_bytes,
            m.sd_cache_bytes / 1048576, total as f64 / 1048576.0, estimate.bytes as f64 / 1048576.0);
    }
}
