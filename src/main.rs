//! codeboss - Vanity git commit hash miner
//!
//! Finds commit messages that produce a target hash prefix.
//!
//! Template syntax: `{option1|option2|option3}` with nesting support.
//! Example: `{fix|Fix}: {the|a} {bug|issue}` → 8 variations

use rayon::prelude::*;
use sha1::{Digest, Sha1};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

// =============================================================================
// Main
// =============================================================================

fn main() {
    let raw_args: Vec<String> = std::env::args().collect();

    // Quick benchmark mode: codeboss --bench-gen <template>
    if raw_args.len() == 3 && raw_args[1] == "--bench-gen" {
        bench_generation(&raw_args[2]);
        return;
    }

    let args = parse_args();
    let slots = expand_template(&args.template);

    validate_entropy(&slots);
    print_mining_info(&slots, &args.target);

    let commit_header = build_commit_header(&args);
    let target = parse_hex_target(&args.target);

    match mine_vanity_hash(&slots, &commit_header, target) {
        Some(result) => print_success(&result),
        None => print_failure(),
    }
}

/// Benchmark string generation only (no hashing)
fn bench_generation(template: &str) {
    let slots = expand_template(template);
    let counts = slot_counts(&slots);
    let total = total_variations(&slots);

    eprintln!("Slots: {}", slots.len());
    eprintln!("Variations: {} ({:.1} bits)", total, (total as f64).log2());
    eprintln!();

    let mut odometer = Odometer::new(counts);
    let mut output = vec![0u8; 4096];

    let iterations = 100_000_000u64;
    let start = Instant::now();

    for _ in 0..iterations {
        let _ = generate_message(&slots, odometer.indices(), &mut output);
        odometer.advance();
    }

    let elapsed = start.elapsed().as_secs_f64();
    let rate = iterations as f64 / elapsed / 1_000_000.0;

    eprintln!("{} iterations in {:.2}s", iterations, elapsed);
    eprintln!("{:.0} M/sec (single thread)", rate);
}

// =============================================================================
// Domain Types
// =============================================================================

/// A slot in the expanded template - one position with multiple possible byte sequences.
/// Stored in packed format for cache-efficient enumeration.
struct Slot {
    data: Box<[u8]>,
    offsets: Box<[(u32, u16)]>, // (offset, length) for each variation
}

impl Slot {
    fn from_variations(variations: Vec<String>) -> Self {
        let mut data = Vec::new();
        let mut offsets = Vec::with_capacity(variations.len());

        for v in &variations {
            offsets.push((data.len() as u32, v.len() as u16));
            data.extend_from_slice(v.as_bytes());
        }

        Self {
            data: data.into_boxed_slice(),
            offsets: offsets.into_boxed_slice(),
        }
    }

    fn variation_count(&self) -> usize {
        self.offsets.len()
    }

    /// Copy the selected variation into dest, return bytes written.
    /// SAFETY: idx must be < variation_count(), dest must have enough space.
    #[inline(always)]
    unsafe fn copy_variation_unchecked(&self, idx: usize, dest: *mut u8) -> usize {
        let (off, len) = *self.offsets.get_unchecked(idx);
        std::ptr::copy_nonoverlapping(self.data.as_ptr().add(off as usize), dest, len as usize);
        len as usize
    }
}

/// Result of a successful mining operation.
struct MiningResult {
    message: String,
    hash: String,
    attempts: u64,
    duration_secs: f64,
}

// =============================================================================
// Template Parsing
// =============================================================================
//
// Syntax:
//   {a|b|c}  - choice between alternatives
//   {nested {x|y}|z}  - nested choices
//   \{ \} \| \\  - escaped literals

#[derive(Debug, Clone)]
enum Node {
    Literal(String),
    Choice(Vec<Vec<Node>>),
}

fn parse_template(template: &str) -> Vec<Node> {
    let bytes = template.as_bytes();
    let mut pos = 0;
    parse_sequence(bytes, &mut pos, &[])
}

fn parse_sequence(bytes: &[u8], pos: &mut usize, stop_at: &[u8]) -> Vec<Node> {
    let mut nodes = Vec::new();
    let mut literal = String::new();

    while *pos < bytes.len() {
        let ch = bytes[*pos];

        // Handle escape sequences
        if ch == b'\\' && *pos + 1 < bytes.len() {
            let next = bytes[*pos + 1];
            if matches!(next, b'{' | b'}' | b'|' | b'\\') {
                literal.push(next as char);
                *pos += 2;
                continue;
            }
        }

        // Stop at delimiter (unescaped)
        if stop_at.contains(&ch) {
            flush_literal(&mut literal, &mut nodes);
            return nodes;
        }

        // Start of choice group
        if ch == b'{' {
            flush_literal(&mut literal, &mut nodes);
            *pos += 1;
            nodes.push(parse_choice(bytes, pos));
        } else {
            literal.push(ch as char);
            *pos += 1;
        }
    }

    flush_literal(&mut literal, &mut nodes);
    nodes
}

fn parse_choice(bytes: &[u8], pos: &mut usize) -> Node {
    let mut alternatives = Vec::new();

    loop {
        alternatives.push(parse_sequence(bytes, pos, &[b'|', b'}']));

        if *pos >= bytes.len() {
            panic!("Unclosed brace in template");
        }

        let ch = bytes[*pos];
        *pos += 1;

        if ch == b'}' {
            break;
        }
    }

    Node::Choice(alternatives)
}

fn flush_literal(literal: &mut String, nodes: &mut Vec<Node>) {
    if !literal.is_empty() {
        nodes.push(Node::Literal(std::mem::take(literal)));
    }
}

// =============================================================================
// Template Expansion
// =============================================================================

const MAX_VARIATIONS_PER_SLOT: usize = 8192;

fn expand_template(template: &str) -> Vec<Slot> {
    let nodes = parse_template(template);
    expand_nodes_to_slots(&nodes)
}

fn expand_nodes_to_slots(nodes: &[Node]) -> Vec<Slot> {
    let mut slots = Vec::new();
    let mut i = 0;

    while i < nodes.len() {
        let end = find_slot_boundary(nodes, i);
        let variations = expand_to_strings(&nodes[i..end]);

        if !variations.is_empty() {
            slots.push(Slot::from_variations(variations));
        }

        i = end;
    }

    slots
}

/// Find the largest range starting at `start` that stays under MAX_VARIATIONS_PER_SLOT.
fn find_slot_boundary(nodes: &[Node], start: usize) -> usize {
    let mut end = start + 1;
    while end < nodes.len() && count_variations(&nodes[start..=end]) <= MAX_VARIATIONS_PER_SLOT {
        end += 1;
    }
    end
}

fn count_variations(nodes: &[Node]) -> usize {
    nodes.iter().fold(1usize, |acc, node| {
        let multiplier = match node {
            Node::Literal(_) => 1,
            Node::Choice(alts) => alts.iter().map(|a| count_variations(a)).sum(),
        };
        acc.saturating_mul(multiplier)
    })
}

fn expand_to_strings(nodes: &[Node]) -> Vec<String> {
    if nodes.is_empty() {
        return vec![String::new()];
    }

    let first = &nodes[0];
    let rest = expand_to_strings(&nodes[1..]);

    match first {
        Node::Literal(s) => rest.into_iter().map(|r| format!("{}{}", s, r)).collect(),
        Node::Choice(alts) => alts
            .iter()
            .flat_map(|alt| expand_to_strings(alt))
            .flat_map(|prefix| rest.iter().map(move |suffix| format!("{}{}", prefix, suffix)))
            .collect(),
    }
}

// =============================================================================
// Slot Enumeration
// =============================================================================

fn total_variations(slots: &[Slot]) -> u128 {
    slots
        .iter()
        .map(|s| s.variation_count() as u128)
        .product()
}

fn entropy_bits(slots: &[Slot]) -> f64 {
    (total_variations(slots) as f64).log2()
}

fn slot_counts(slots: &[Slot]) -> Vec<usize> {
    slots.iter().map(|s| s.variation_count()).collect()
}

/// Generate message by copying selected variation from each slot.
/// Returns bytes written.
#[inline(always)]
fn generate_message(slots: &[Slot], indices: &[usize], output: &mut [u8]) -> usize {
    let mut pos = 0;
    let out = output.as_mut_ptr();

    for (slot, &idx) in slots.iter().zip(indices.iter()) {
        pos += unsafe { slot.copy_variation_unchecked(idx, out.add(pos)) };
    }

    pos
}

/// Odometer-style index iterator for enumerating all combinations.
struct Odometer {
    indices: Vec<usize>,
    counts: Vec<usize>,
}

impl Odometer {
    fn new(counts: Vec<usize>) -> Self {
        let indices = vec![0; counts.len()];
        Self { indices, counts }
    }

    fn set_position(&mut self, flat_index: u64) {
        let mut n = flat_index;
        for i in 0..self.indices.len() {
            self.indices[i] = (n % self.counts[i] as u64) as usize;
            n /= self.counts[i] as u64;
        }
    }

    fn advance(&mut self) {
        for i in 0..self.indices.len() {
            self.indices[i] += 1;
            if self.indices[i] < self.counts[i] {
                return;
            }
            self.indices[i] = 0;
        }
    }

    fn indices(&self) -> &[usize] {
        &self.indices
    }
}

// =============================================================================
// Commit Building & Hashing
// =============================================================================

fn build_commit_header(args: &CliArgs) -> Vec<u8> {
    format!(
        "tree {}\nparent {}\nauthor {} {} {}\ncommitter {} {} {}\n\n",
        args.tree,
        args.parent,
        args.author,
        args.timestamp,
        args.timezone,
        args.author,
        args.timestamp,
        args.timezone
    )
    .into_bytes()
}

/// Build full git commit object: "commit {len}\0{header}{message}\n"
#[inline(always)]
fn build_commit_object(header: &[u8], message: &[u8], buffer: &mut [u8]) -> usize {
    let content_len = header.len() + message.len() + 1;
    let git_header = format!("commit {}\x00", content_len);
    let git_header_bytes = git_header.as_bytes();

    let mut pos = 0;
    buffer[pos..pos + git_header_bytes.len()].copy_from_slice(git_header_bytes);
    pos += git_header_bytes.len();

    buffer[pos..pos + header.len()].copy_from_slice(header);
    pos += header.len();

    buffer[pos..pos + message.len()].copy_from_slice(message);
    pos += message.len();

    buffer[pos] = b'\n';
    pos + 1
}

#[inline(always)]
fn hash_commit(data: &[u8]) -> [u8; 20] {
    Sha1::digest(data).into()
}

#[inline(always)]
fn hash_matches_target(hash: &[u8; 20], target: u32) -> bool {
    let prefix = u32::from_be_bytes([hash[0], hash[1], hash[2], hash[3]]);
    prefix == target
}

fn hash_to_hex(hash: &[u8; 20]) -> String {
    hash.iter().map(|b| format!("{:02x}", b)).collect()
}

// =============================================================================
// Mining
// =============================================================================

const CHUNK_SIZE: u64 = 1_000_000;

fn mine_vanity_hash(slots: &[Slot], commit_header: &[u8], target: u32) -> Option<MiningResult> {
    let found = AtomicBool::new(false);
    let attempts = AtomicU64::new(0);
    let start = Instant::now();

    let num_threads = rayon::current_num_threads();
    let total = total_variations(slots);
    let counts = slot_counts(slots);

    let result: Option<(String, String)> = (0..num_threads).into_par_iter().find_map_any(|tid| {
        mine_thread(
            slots,
            &counts,
            commit_header,
            target,
            tid,
            num_threads,
            total,
            &found,
            &attempts,
            &start,
        )
    });

    let elapsed = start.elapsed().as_secs_f64();
    let total_attempts = attempts.load(Ordering::Relaxed);

    result.map(|(message, hash)| MiningResult {
        message,
        hash,
        attempts: total_attempts,
        duration_secs: elapsed,
    })
}

fn mine_thread(
    slots: &[Slot],
    counts: &[usize],
    commit_header: &[u8],
    target: u32,
    thread_id: usize,
    num_threads: usize,
    total_variations: u128,
    found: &AtomicBool,
    attempts: &AtomicU64,
    start: &Instant,
) -> Option<(String, String)> {
    let mut odometer = Odometer::new(counts.to_vec());
    let mut message_buf = vec![0u8; 4096];
    let mut commit_buf = vec![0u8; 8192];

    let mut offset = thread_id as u64 * CHUNK_SIZE;

    loop {
        if found.load(Ordering::Relaxed) {
            return None;
        }

        odometer.set_position(offset);

        for _ in 0..CHUNK_SIZE {
            let msg_len = generate_message(slots, odometer.indices(), &mut message_buf);
            let commit_len =
                build_commit_object(commit_header, &message_buf[..msg_len], &mut commit_buf);
            let hash = hash_commit(&commit_buf[..commit_len]);

            if hash_matches_target(&hash, target) {
                found.store(true, Ordering::Relaxed);
                let message = String::from_utf8_lossy(&message_buf[..msg_len]).to_string();
                return Some((message, hash_to_hex(&hash)));
            }

            odometer.advance();
        }

        let total = attempts.fetch_add(CHUNK_SIZE, Ordering::Relaxed) + CHUNK_SIZE;
        offset += num_threads as u64 * CHUNK_SIZE;

        report_progress(thread_id, total, start);

        if offset as u128 >= total_variations {
            return None;
        }
    }
}

fn report_progress(thread_id: usize, total: u64, start: &Instant) {
    if thread_id == 0 && total % 100_000_000 < CHUNK_SIZE {
        let elapsed = start.elapsed().as_secs_f64();
        let rate = total as f64 / elapsed / 1_000_000.0;
        eprintln!("{} M attempts, {:.0} M/sec", total / 1_000_000, rate);
    }
}

// =============================================================================
// CLI
// =============================================================================

struct CliArgs {
    template: String,
    tree: String,
    parent: String,
    author: String,
    timestamp: String,
    timezone: String,
    target: String,
}

fn parse_args() -> CliArgs {
    let args: Vec<String> = std::env::args().collect();

    if args.len() != 8 {
        print_usage();
        std::process::exit(1);
    }

    CliArgs {
        template: args[1].clone(),
        tree: args[2].clone(),
        parent: args[3].clone(),
        author: args[4].clone(),
        timestamp: args[5].clone(),
        timezone: args[6].clone(),
        target: args[7].clone(),
    }
}

fn print_usage() {
    eprintln!(
        "Usage: codeboss <template> <tree> <parent> <author> <timestamp> <timezone> <target>"
    );
    eprintln!(
        "Example: codeboss '{{fix|Fix}}: typo' abc123 def456 'Name <email>' 1234567890 +0000 c0deb055"
    );
}

fn parse_hex_target(target: &str) -> u32 {
    u32::from_str_radix(target, 16).expect("Invalid target hex")
}

// =============================================================================
// Output
// =============================================================================

fn validate_entropy(slots: &[Slot]) {
    let bits = entropy_bits(slots);
    if bits < 37.0 {
        eprintln!("❌ ERROR: Template has only {:.1} bits of entropy", bits);
        eprintln!("   Minimum required: 37 bits");
        eprintln!("   Add more variations to your template");
        std::process::exit(2);
    }
}

fn print_mining_info(slots: &[Slot], target: &str) {
    eprintln!(
        "Template: {} variations ({:.1} bits)",
        total_variations(slots),
        entropy_bits(slots)
    );
    eprintln!("Target: {}", target);
    eprintln!("Threads: {}", rayon::current_num_threads());
    eprintln!();
}

fn print_success(result: &MiningResult) {
    let rate = result.attempts as f64 / result.duration_secs / 1_000_000.0;
    eprintln!();
    eprintln!(
        "Found in {:.2}s ({} attempts, {:.0} M/sec)",
        result.duration_secs, result.attempts, rate
    );
    eprintln!("Hash: {}", result.hash);
    println!("{}", result.message);
}

fn print_failure() {
    eprintln!();
    eprintln!("Exhausted all variations without finding match");
    std::process::exit(1);
}
