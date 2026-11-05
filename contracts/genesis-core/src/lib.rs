//! Genesis Core — minimal on-chain rules for the agent lifecycle.
//! Designed for NEAR HACKATHON 2026 (AI Swarms / Agent Economy / NFTs That Do Something).
//!
//! Core ideas enforced on-chain:
//! - Agents are registered with generation, parent, skills and status.
//!   Ordinary birth is gen 0 only, for the caller or by the Core owner;
//!   higher generations are earned (evolve) or bred, never bought.
//! - Birth can be funded by treasury (Gen 0) or by parent balance.
//! - Jobs can be posted with an escrow deposit. The contract tracks open
//!   job liabilities and never pays more than it holds.
//! - On successful verification the agent is paid from the escrow.
//!   Settlement is owner-only (the verifier), one payment per job, and
//!   only when the score beats the onchain frontier.
//! - Death is owner-only, or permissionless once the contract has
//!   recorded enough verified failures (max_consecutive_fails).
//! - Difficulty is labinius-style: a job only pays when the agent's score
//!   BEATS the frontier (the best score on that job definition, stored
//!   onchain). The bar rises every time someone beats it.
//! - Agent gen NFTs can be bought and sold in the Core's escrow marketplace:
//!   the seller sends the NFT to the Core, a buyer pays the listed price,
//!   the Core releases the NFT and pays the seller (5% fee to the treasury).
//!   A failed transfer restores the listing instead of stranding the NFT.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// The shared NEP-171 NFT contract Genesis mints on. Only calls from this
/// account are accepted as NFT transfers into the marketplace. This is the
/// DEFAULT: the live value lives in `Contract.nft_contract` (set at init,
/// changeable by the owner via `set_nft_contract`) so a mainnet deploy
/// does not hardcode the testnet contract.
pub const NFT_CONTRACT: &str = "nft.primitives.testnet";
/// Schema version of the persisted state. Bumped on every state-shape
/// change; `migrate()` refuses to run twice and refuses a wrong source
/// version.
pub const SCHEMA_VERSION: u32 = 3;
/// Marketplace fee, in basis points (500 = 5%), paid to the Core owner.
pub const MARKETPLACE_FEE_BPS: u128 = 500;
/// Paid jobs (wins) needed to evolve one generation. Same for every
/// generation, so the path is simple and predictable: 3 wins per gen,
/// 27 wins from gen 0 to the final gen 9.
pub const WINS_TO_EVOLVE: u32 = 3;
/// The final generation. Gen 9 is the last designed card (gen 0–9 exist,
/// gen-x is for 10+). An agent at gen 9 cannot evolve further.
pub const MAX_GENERATION: u32 = 9;
/// Skill boost per evolution (gen 1 is smarter than gen 0, gen 2 smarter
/// than gen 1, and so on). Capped at 2.0 per skill.
pub const EVOLVE_QUALITY_BOOST: f32 = 0.1;
pub const EVOLVE_SPEED_BOOST: f32 = 0.05;
pub const EVOLVE_COST_EFF_BOOST: f32 = 0.05;
pub const MAX_SKILL: f32 = 2.0;

/// Simple skill set that mutates on birth.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Skill {
    pub speed: f32,
    pub quality: f32,
    pub cost_eff: f32,
}

impl Default for Skill {
    fn default() -> Self {
        Self {
            speed: 1.0,
            quality: 1.0,
            cost_eff: 1.0,
        }
    }
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub enum AgentStatus {
    Alive,
    Dead,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Agent {
    pub token_id: String,
    pub owner_id: AccountId,
    pub generation: u32,
    pub parent: Option<String>,
    /// Second parent, set only by two-parent breeding (`breed`). Single
    /// parent births (Gen 0, parent-funded) leave this None. The primary
    /// parent stays in `parent`, so existing readers keep working.
    pub second_parent: Option<String>,
    pub skill: Skill,
    pub status: AgentStatus,
    pub jobs_done: u32,
    pub consecutive_fails: u32,
    /// Paid jobs this agent has won (incremented in `pay_job` when the
    /// winner is this agent's owner). Wins are the currency of evolution:
    /// 3 wins since the last evolution earns the next generation.
    pub wins: u32,
    /// How many times this agent has evolved. The next evolution needs
    /// (evolutions + 1) * WINS_TO_EVOLVE total wins.
    pub evolutions: u32,
    // U128 has no JsonSchema impl in near-sdk 5.30; it serialises as a
    // string in JSON, so declare the schema as String for the ABI.
    #[schemars(with = "String")]
    pub earned: U128,          // yoctoNEAR
    pub created_at: u64,       // block timestamp
}

/// Evolution progress for one agent, returned by `get_evolve_status`.
/// A win is a paid job; 3 wins since the last evolution earns the next
/// generation, up to the final gen 9.
#[derive(Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct EvolveStatus {
    pub token_id: String,
    pub generation: u32,
    pub wins: u32,
    pub evolutions: u32,
    pub wins_needed: u32,
    pub can_evolve: bool,
    pub max_generation: u32,
    pub wins_to_evolve: u32,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Job {
    pub job_id: String,
    pub poster: AccountId,
    // U128 has no JsonSchema impl in near-sdk 5.30; it serialises as a
    // string in JSON, so declare the schema as String for the ABI.
    #[schemars(with = "String")]
    pub reward: U128,
    pub brief: String,
    pub keywords: Vec<String>,
    pub min_words: u32,
    pub status: String,        // "open" | "claimed" | "paid" | "cancelled"
    pub winner: Option<AccountId>,
}

/// Best score on one job definition (labinius-style frontier).
/// job_def_id = sha256(brief + '|' + keywords.join(',') + '|' + source).
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Frontier {
    pub best_score: u32,
    pub best_output_hash: String,
    pub winner: AccountId,
}

/// One marketplace listing. The NFT itself is held by this contract
/// (escrow) while listed; the seller is the account that sent it in.
/// `status` is the sale state machine: "listed" (for sale) or
/// "sale_pending" (a buy is in flight — the NFT transfer has been issued
/// but its callback has not resolved yet). A failed transfer restores
/// "listed" instead of deleting the listing, so the NFT is never stranded
/// in the Core with no record of who it belongs to.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Listing {
    pub token_id: String,
    pub seller: AccountId,
    // U128 has no JsonSchema impl in near-sdk 5.30; see Agent.earned above.
    #[schemars(with = "String")]
    pub price: U128,           // yoctoNEAR
    pub listed_at: u64,        // block timestamp
    pub status: String,        // "listed" | "sale_pending"
    pub buyer: Option<AccountId>, // set while a sale is pending
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    pub agents: UnorderedMap<String, Agent>,
    /// Reverse owner -> token index (first agent registered for an owner).
    /// Replaces the linear scan over all agents in `agent_token_for_owner`
    /// — the scan is O(n) per settlement and grows with the registry.
    pub owner_index: LookupMap<AccountId, String>,
    /// The NFT contract accepted by the marketplace. Configurable (see
    /// `set_nft_contract`) so a mainnet deploy is not locked to testnet.
    pub nft_contract: AccountId,
    /// Schema version of this persisted state (see SCHEMA_VERSION).
    pub schema_version: u32,
    pub jobs: UnorderedMap<String, Job>,
    pub birth_cost: U128,      // yoctoNEAR required to birth
    pub profit_threshold: U128,
    pub max_consecutive_fails: u32,
    pub min_jobs_to_reproduce: u32,
    pub frontiers: UnorderedMap<String, Frontier>,
    pub listings: UnorderedMap<String, Listing>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, treasury: AccountId) -> Self {
        Self {
            owner_id,
            treasury,
            agents: UnorderedMap::new(b"a"),
            owner_index: LookupMap::new(b"o"),
            nft_contract: NFT_CONTRACT.parse().expect("bad NFT contract id"),
            schema_version: SCHEMA_VERSION,
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(NearToken::from_near(0).as_yoctonear()), // set realistically after deploy
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        }
    }

    // ─── Views ───────────────────────────────────────────────

    pub fn get_agent(&self, token_id: String) -> Option<Agent> {
        self.agents.get(&token_id)
    }

    pub fn get_job(&self, job_id: String) -> Option<Job> {
        self.jobs.get(&job_id)
    }

    pub fn agent_count(&self) -> u64 {
        self.agents.len()
    }

    pub fn get_frontier(&self, job_def_id: String) -> Option<Frontier> {
        self.frontiers.get(&job_def_id)
    }

    pub fn get_listing(&self, token_id: String) -> Option<Listing> {
        self.listings.get(&token_id)
    }

    pub fn get_listings(&self) -> Vec<Listing> {
        self.listings.values().collect()
    }

    /// Every job ever posted (open, paid, cancelled). The onchain job
    /// board reads this; the payment service reads it through
    /// `get_paid_to` for the per-account cap. No pagination yet — the
    /// job count is small; add from_index/limit if it ever grows large.
    pub fn get_jobs(&self) -> Vec<Job> {
        self.jobs.values().collect()
    }

    /// Total yoctoNEAR ever paid to one account across all paid jobs.
    /// The payment service enforces the per-account cap from this (no
    /// external store needed — the Core is the source of truth). A job
    /// counts once it is "paid"; open or cancelled jobs do not count.
    pub fn get_paid_to(&self, account_id: AccountId) -> U128 {
        let total: u128 = self
            .jobs
            .values()
            .filter(|j| j.status == "paid" && j.winner.as_ref() == Some(&account_id))
            .map(|j| j.reward.0)
            .sum();
        U128(total)
    }

    /// Total yoctoNEAR currently owed to open jobs — the contract's live
    /// escrow liability. The invariant `account_balance >=
    /// open_liabilities` must hold at all times: one job's payout must
    /// never consume funds economically owed to another job. `pay_job`
    /// asserts it before paying; `post_job` can only add a liability
    /// together with its deposit, so it holds by construction there.
    pub fn get_open_liabilities(&self) -> U128 {
        U128(self.open_liabilities())
    }

    /// Sum of rewards of all jobs still "open". Kept as a helper (not a
    /// stored field) so it can never drift from the job records.
    fn open_liabilities(&self) -> u128 {
        self.jobs
            .values()
            .filter(|j| j.status == "open")
            .map(|j| j.reward.0)
            .sum()
    }

    /// Evolution progress for one agent: how many wins it has, how many
    /// it needs for the next generation, and whether it can evolve now.
    /// A win is a paid job (recorded in `pay_job`). The next evolution
    /// needs (evolutions + 1) * WINS_TO_EVOLVE total wins — 3 wins since
    /// the last evolution. Gen 9 is the final generation and cannot evolve.
    pub fn get_evolve_status(&self, token_id: String) -> Option<EvolveStatus> {
        let agent = self.agents.get(&token_id)?;
        let wins_needed = if agent.generation >= MAX_GENERATION {
            0
        } else {
            ((agent.evolutions + 1) * WINS_TO_EVOLVE).saturating_sub(agent.wins)
        };
        Some(EvolveStatus {
            token_id: agent.token_id,
            generation: agent.generation,
            wins: agent.wins,
            evolutions: agent.evolutions,
            wins_needed,
            can_evolve: agent.status == AgentStatus::Alive
                && agent.generation < MAX_GENERATION
                && wins_needed == 0,
            max_generation: MAX_GENERATION,
            wins_to_evolve: WINS_TO_EVOLVE,
        })
    }

    // ─── Birth ───────────────────────────────────────────────

    /// Register a new agent. Ordinary birth is gen 0 only — higher
    /// generations are earned (evolve) or bred, never bought or forged.
    ///
    /// Enforced onchain (a 2026-11-05 review found all of these missing):
    /// - the caller must be the agent's owner, or the Core owner
    ///   (treasury/operator, which births for new agent owners through
    ///   the mint flow). A random account cannot register an agent owned
    ///   by someone else.
    /// - generation must be 0, and a gen-0 agent has no parent.
    ///   Offspring are created by `breed`, not by `birth`.
    /// - skills must be inside [0.5, 2.0] (the same bounds as breeding
    ///   and evolution); an omitted skill defaults to 1.0/1.0/1.0.
    /// - the caller attaches exactly `birth_cost` — no more (excess
    ///   deposits used to stay in the contract), no less.
    #[payable]
    pub fn birth(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        generation: u32,
        parent: Option<String>,
        skill: Option<Skill>,
    ) {
        assert!(self.agents.get(&token_id).is_none(), "Agent already exists");
        let caller = env::predecessor_account_id();
        assert!(
            caller == owner_id || caller == self.owner_id,
            "Only the agent owner or the Core owner can register an agent"
        );
        assert_eq!(generation, 0, "Ordinary birth is gen 0 only — higher generations are earned or bred");
        assert!(parent.is_none(), "A gen-0 agent has no parent — use breed for offspring");
        let skill = skill.unwrap_or_default();
        assert!(
            (0.5..=2.0).contains(&skill.speed)
                && (0.5..=2.0).contains(&skill.quality)
                && (0.5..=2.0).contains(&skill.cost_eff),
            "Skills must be inside [0.5, 2.0]"
        );
        let deposit = env::attached_deposit();
        assert_eq!(
            deposit.as_yoctonear(),
            self.birth_cost.0,
            "Must attach exactly birth_cost"
        );

        let agent = Agent {
            token_id: token_id.clone(),
            owner_id: owner_id.clone(),
            generation,
            parent,
            second_parent: None,
            skill,
            status: AgentStatus::Alive,
            jobs_done: 0,
            consecutive_fails: 0,
            wins: 0,
            evolutions: 0,
            earned: U128(0),
            created_at: env::block_timestamp(),
        };
        self.agents.insert(&token_id, &agent);
        // First agent registered for this owner wins the index slot;
        // later agents of the same owner do not overwrite it.
        if self.owner_index.get(&owner_id).is_none() {
            self.owner_index.insert(&owner_id, &token_id);
        }
    }

    /// Two-parent breeding: breed two proven (registered, alive) agents
    /// into a child that combines their skills.
    ///
    /// - Both parents must exist in the registry and be alive. A dead
    ///   agent cannot breed.
    /// - The caller must own at least one parent, or be the Core owner
    ///   (treasury/operator, which breeds through the paid breed flow).
    ///   A random account cannot breed someone else's agents.
    /// - Each parent must have completed at least `min_jobs_to_reproduce`
    ///   paid jobs: only proven agents reproduce. (Live note: genesis-gen-2
    ///   has 0 completed paid jobs since the v2.2 migration, so it cannot
    ///   breed again until it wins 3 — genesis-gen-3, with 3, can.)
    /// - The child generation is max(parent generations) + 1.
    /// - Each child skill is the average of the two parents' skills plus
    ///   a small mutation (derived from `env::random_seed`, clamped to
    ///   0.5–2.0), so the child is a mix of both parents, not a copy of
    ///   either one. Block timestamps are predictable and must not be
    ///   treated as randomness.
    /// - The caller attaches exactly the birth cost (same as `birth`).
    ///   Parent-funded reproduction (debiting a parent's onchain balance)
    ///   is not implemented yet: agent earnings are paid out to owners,
    ///   not held as a spendable balance — that needs the agent ledger
    ///   (available/locked/earned), a follow-up, not a silent debit.
    ///   The child NFT itself is minted separately (the CLI/site mint
    ///   records both parents in the token metadata `extra`).
    #[payable]
    pub fn breed(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        parent1: String,
        parent2: String,
    ) {
        assert!(self.agents.get(&token_id).is_none(), "Agent already exists");
        let p1 = self.agents.get(&parent1).expect("Parent 1 not registered");
        let p2 = self.agents.get(&parent2).expect("Parent 2 not registered");
        assert!(p1.status == AgentStatus::Alive, "Parent 1 is not alive");
        assert!(p2.status == AgentStatus::Alive, "Parent 2 is not alive");
        let caller = env::predecessor_account_id();
        assert!(
            caller == p1.owner_id || caller == p2.owner_id || caller == self.owner_id,
            "Only a parent's owner or the Core owner can breed these agents"
        );
        assert!(
            p1.jobs_done >= self.min_jobs_to_reproduce,
            "Parent 1 has not completed enough jobs to reproduce"
        );
        assert!(
            p2.jobs_done >= self.min_jobs_to_reproduce,
            "Parent 2 has not completed enough jobs to reproduce"
        );
        let deposit = env::attached_deposit();
        assert_eq!(
            deposit.as_yoctonear(),
            self.birth_cost.0,
            "Must attach exactly birth_cost"
        );
        let generation = std::cmp::max(p1.generation, p2.generation) + 1;
        // Small mutation from the block's random seed: a pseudo-random
        // delta in [-0.05, +0.14] per skill, so the child varies slightly
        // from the plain average of its parents.
        let seed = env::random_seed();
        let delta = |i: usize| -> f32 {
            let b = *seed.get(i).unwrap_or(&0);
            ((b % 20) as f32) / 100.0 - 0.05
        };
        let mix = |a: f32, b: f32, i: usize| -> f32 {
            ((a + b) / 2.0 + delta(i)).clamp(0.5, 2.0)
        };
        let skill = Skill {
            speed: mix(p1.skill.speed, p2.skill.speed, 0),
            quality: mix(p1.skill.quality, p2.skill.quality, 1),
            cost_eff: mix(p1.skill.cost_eff, p2.skill.cost_eff, 2),
        };
        let agent = Agent {
            token_id: token_id.clone(),
            owner_id: owner_id.clone(),
            generation,
            parent: Some(parent1),
            second_parent: Some(parent2),
            skill,
            status: AgentStatus::Alive,
            jobs_done: 0,
            consecutive_fails: 0,
            wins: 0,
            evolutions: 0,
            earned: U128(0),
            created_at: env::block_timestamp(),
        };
        self.agents.insert(&token_id, &agent);
        if self.owner_index.get(&owner_id).is_none() {
            self.owner_index.insert(&owner_id, &token_id);
        }
    }

    /// Evolve one generation by winning. Minting is gen 0 only — a higher
    /// generation is EARNED, never bought. An agent evolves when it has
    /// WINS_TO_EVOLVE (3) more paid wins since its last evolution, up to
    /// the final gen 9. Each evolution makes the agent smarter: quality
    /// +0.1, speed +0.05, cost_eff +0.05 (each capped at 2.0), so gen 1 is
    /// smarter than gen 0, gen 2 smarter than gen 1, and so on. The token
    /// keeps its id (the NFT is the birth card); the generation and skills
    /// live in this registry, and the site/CV/marketplace read them from
    /// here, so they always show the current generation.
    ///
    /// Only the agent's owner or the Core owner can trigger an evolution.
    /// The threshold itself is onchain (wins recorded by `pay_job`), so
    /// no caller can evolve an agent that has not earned it.
    pub fn evolve(&mut self, token_id: String) {
        let mut agent = self.agents.get(&token_id).expect("Agent not found");
        assert_eq!(agent.status, AgentStatus::Alive, "Agent is not alive");
        let caller = env::predecessor_account_id();
        assert!(
            caller == agent.owner_id || caller == self.owner_id,
            "Only the agent owner or the Core owner can evolve it"
        );
        assert!(
            agent.generation < MAX_GENERATION,
            "Agent is already at the final generation"
        );
        let wins_needed = (agent.evolutions + 1) * WINS_TO_EVOLVE;
        assert!(
            agent.wins >= wins_needed,
            "Agent needs more wins to evolve"
        );
        agent.generation += 1;
        agent.evolutions += 1;
        agent.skill = Skill {
            speed: (agent.skill.speed + EVOLVE_SPEED_BOOST).min(MAX_SKILL),
            quality: (agent.skill.quality + EVOLVE_QUALITY_BOOST).min(MAX_SKILL),
            cost_eff: (agent.skill.cost_eff + EVOLVE_COST_EFF_BOOST).min(MAX_SKILL),
        };
        self.agents.insert(&token_id, &agent);
    }

    // ─── Jobs & Escrow ───────────────────────────────────────────

    /// Post a job and lock the reward as escrow inside the contract.
    #[payable]
    pub fn post_job(
        &mut self,
        job_id: String,
        brief: String,
        keywords: Vec<String>,
        min_words: u32,
    ) {
        assert!(self.jobs.get(&job_id).is_none(), "Job already exists");
        let reward = env::attached_deposit();
        assert!(reward.as_yoctonear() > 0, "Must attach reward");

        let job = Job {
            job_id: job_id.clone(),
            poster: env::predecessor_account_id(),
            reward: U128(reward.as_yoctonear()),
            brief,
            keywords,
            min_words,
            status: "open".to_string(),
            winner: None,
        };
        self.jobs.insert(&job_id, &job);
    }

    /// Pay the winner of a job. Only the contract owner (the verifier)
    /// can call this after off-chain verification. Moves the escrowed
    /// reward to the winning agent account.
    ///
    /// Labinius rule: the score must BEAT the frontier for this job
    /// definition (job_def_id = sha256 of brief + keywords + source). The
    /// first paying score sets the frontier; a later score must be strictly
    /// higher, or this call panics and nothing is paid. The frontier is
    /// updated here, onchain, so no race can pay a beaten score.
    ///
    /// Funds safety (a 2026-11-05 review found these missing): the job
    /// must be "open" (no duplicate settlement), and the contract must
    /// hold at least its total open-job liabilities before paying — one
    /// job's payout cannot consume funds owed to another job. The
    /// transfer is issued after the state is final; the balance check
    /// makes a failed transfer to a valid account effectively
    /// impossible. The verifier itself is the Core owner in this version
    /// (documented governance, not a signed receipt — that is the P1
    /// follow-up: signed verification receipts with nonce/expiry, or a
    /// multisig verifier role).
    pub fn pay_job(&mut self, job_id: String, winner: AccountId, score: u32, job_def_id: String) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only owner can settle jobs in this version"
        );
        let mut job = self.jobs.get(&job_id).expect("Job not found");
        assert_eq!(job.status, "open", "Job is not open");
        if let Some(frontier) = self.frontiers.get(&job_def_id) {
            assert!(
                score > frontier.best_score,
                "Score does not beat the frontier"
            );
        }
        assert!(
            env::account_balance().as_yoctonear() >= self.open_liabilities(),
            "Contract balance does not cover open job liabilities"
        );
        self.frontiers.insert(
            &job_def_id,
            &Frontier {
                best_score: score,
                best_output_hash: job_id.clone(),
                winner: winner.clone(),
            },
        );
        job.status = "paid".to_string();
        job.winner = Some(winner.clone());
        self.jobs.insert(&job_id, &job);

        // Record the win on the winner's agent (if the winner is a
        // registered agent). A paid job is a completed job, so jobs_done
        // rises too. Wins are the currency of evolution: 3 wins since the
        // last evolution earns the next generation. A win also breaks a
        // failure streak: consecutive_fails resets to 0.
        if let Some(token_id) = self.agent_token_for_owner(&winner) {
            if let Some(mut agent) = self.agents.get(&token_id) {
                agent.wins += 1;
                agent.jobs_done += 1;
                agent.consecutive_fails = 0;
                agent.earned = U128(agent.earned.0 + job.reward.0);
                self.agents.insert(&token_id, &agent);
            }
        }

        // Transfer the escrowed reward
        Promise::new(winner).transfer(NearToken::from_yoctonear(job.reward.0));
    }

    /// Cancel an open job and refund its escrowed reward to the poster.
    /// The poster or the Core owner can cancel; a paid or already
    /// cancelled job cannot be cancelled. Before the review there was no
    /// way to release a stuck job's escrow at all (the status list
    /// mentioned "cancelled" but nothing ever set it).
    #[payable]
    pub fn cancel_job(&mut self, job_id: String) {
        let mut job = self.jobs.get(&job_id).expect("Job not found");
        assert_eq!(job.status, "open", "Job is not open");
        let caller = env::predecessor_account_id();
        assert!(
            caller == job.poster || caller == self.owner_id,
            "Only the job poster or the Core owner can cancel it"
        );
        assert!(
            env::account_balance().as_yoctonear() >= job.reward.0,
            "Contract balance does not cover the refund"
        );
        job.status = "cancelled".to_string();
        self.jobs.insert(&job_id, &job);
        Promise::new(job.poster).transfer(NearToken::from_yoctonear(job.reward.0));
    }

    /// Record a verified failure for an agent (owner/verifier only).
    /// A failure is a completed job attempt that did not pass
    /// verification. `consecutive_fails` is the death-rule counter:
    /// once it reaches `max_consecutive_fails`, anyone may call `die`
    /// (the failure is already recorded onchain, so no trust is needed).
    /// A paid win resets the counter to 0 (see `pay_job`).
    pub fn record_fail(&mut self, token_id: String) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only owner can record failures in this version"
        );
        let mut agent = self.agents.get(&token_id).expect("Agent not found");
        assert_eq!(agent.status, AgentStatus::Alive, "Agent is not alive");
        agent.consecutive_fails += 1;
        self.agents.insert(&token_id, &agent);
    }

    /// Find a registered agent's token by its owner account. Returns None
    /// when the account owns no registered agent (e.g. a human wallet
    /// that won a job). Uses the reverse owner index (first agent
    /// registered for the owner); the old linear scan over all agents
    /// was O(n) per settlement.
    fn agent_token_for_owner(&self, owner: &AccountId) -> Option<String> {
        self.owner_index.get(owner)
    }

    // ─── Marketplace (escrow) ────────────────────────────────────

    /// NEP-171 receiver callback: called by the NFT contract when someone
    /// sends an NFT here with `nft_transfer_call`. The `msg` must be the
    /// listing price in yoctoNEAR as a decimal string. The NFT stays in
    /// this contract (escrow) until it is bought or delisted.
    /// Only calls from the NFT contract are accepted; anything else panics,
    /// so a listing cannot be faked by calling this method directly.
    ///
    /// Return value — INVERTED vs the plain NEP-171 reading, and this is
    /// what near-contract-standards 5.x actually implements in
    /// `nft_resolve_transfer` (the bool is read as `must_revert`): return
    /// `false` to KEEP the token here (listing accepted), return `true` to
    /// send it back to the sender (listing rejected). Returning `true` on
    /// a good listing makes the NFT contract hand the token straight back
    /// to the seller, so the escrow never holds it.
    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_eq!(
            env::predecessor_account_id(),
            self.nft_contract,
            "Only the NFT contract can transfer here"
        );
        let _ = sender_id;
        let price: u128 = match msg.trim().parse() {
            Ok(p) if p > 0 => p,
            // Bad price: return the token to the sender (reject the listing).
            _ => return PromiseOrValue::Value(true),
        };
        // No "already listed" guard here on purpose: the insert below
        // overwrites a STALE listing (one whose token was returned to its
        // seller, e.g. by a rejected transfer). A valid double-list is
        // impossible — the NFT contract only lets the token's owner call
        // `nft_transfer_call`, and a token that is validly listed is owned
        // by this contract, not by its seller — so the only way this runs
        // for an already-listed token is when the seller still owns it,
        // which is exactly the stale case the overwrite repairs.
        self.listings.insert(
            &token_id,
            &Listing {
                token_id: token_id.clone(),
                seller: previous_owner_id,
                price: U128(price),
                listed_at: env::block_timestamp(),
                status: "listed".to_string(),
                buyer: None,
            },
        );
        // Listing accepted: keep the token in escrow (false = do not return).
        PromiseOrValue::Value(false)
    }

    /// Buy a listed NFT. The caller must attach exactly the listing price.
    /// The NFT is transferred to the buyer first; the callback then pays
    /// the seller 95% and the treasury the 5% fee. If the NFT transfer
    /// fails, the buyer is refunded in full AND the listing is restored.
    ///
    /// The listing is NOT removed here. It moves to "sale_pending" with
    /// the buyer recorded, so a failed transfer can restore it (a
    /// 2026-11-05 review found the old code deleted the listing before
    /// the transfer, stranding the NFT in the Core with no record of
    /// who it belonged to). A second buy while a sale is pending panics.
    #[payable]
    pub fn buy_nft(&mut self, token_id: String) -> Promise {
        let mut listing = self.listings.get(&token_id).expect("Token is not listed");
        assert_eq!(listing.status, "listed", "Token sale is already pending");
        let price = listing.price.0;
        let attached = env::attached_deposit().as_yoctonear();
        assert_eq!(attached, price, "Must attach exactly the listing price");
        let buyer = env::predecessor_account_id();
        let seller = listing.seller.clone();
        listing.status = "sale_pending".to_string();
        listing.buyer = Some(buyer.clone());
        self.listings.insert(&token_id, &listing);
        Promise::new(self.nft_contract.clone())
            .function_call(
                "nft_transfer".to_string(),
                near_sdk::serde_json::json!({
                    "receiver_id": buyer,
                    "token_id": token_id,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(100),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_nft_sold".to_string(),
                    near_sdk::serde_json::json!({
                        "token_id": token_id,
                        "seller": seller,
                        "buyer": buyer,
                        "price": price.to_string(),
                    })
                    .to_string()
                    .into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(50),
                ),
            )
    }

    /// Callback after the NFT transfer in `buy_nft`. Private: only this
    /// contract can call it. Idempotent by construction: the listing is
    /// "sale_pending", and each branch resolves it exactly once — success
    /// removes it, failure restores it to "listed". A duplicate callback
    /// finds no "sale_pending" listing and panics instead of paying twice.
    #[private]
    pub fn on_nft_sold(
        &mut self,
        token_id: String,
        seller: AccountId,
        buyer: AccountId,
        price: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        let mut listing = self.listings.get(&token_id).expect("Token is not listed");
        assert_eq!(listing.status, "sale_pending", "No sale is pending for this token");
        match result {
            Ok(()) => {
                self.listings.remove(&token_id);
                let fee = price.0 * MARKETPLACE_FEE_BPS / 10_000;
                let seller_amount = price.0 - fee;
                Promise::new(seller).transfer(NearToken::from_yoctonear(seller_amount));
                if fee > 0 {
                    Promise::new(self.treasury.clone())
                        .transfer(NearToken::from_yoctonear(fee));
                }
            }
            Err(_) => {
                // The NFT never moved: restore the listing so the seller
                // can delist or sell again, and refund the buyer in full.
                listing.status = "listed".to_string();
                listing.buyer = None;
                self.listings.insert(&token_id, &listing);
                Promise::new(buyer).transfer(NearToken::from_yoctonear(price.0));
            }
        }
    }

    /// Delist an NFT. Only the seller can call it, and only while the
    /// listing is "listed" (not mid-sale). The NFT is transferred back
    /// first; the listing is removed by the callback only when that
    /// transfer succeeds, so a failed transfer never strands the NFT.
    pub fn delist_nft(&mut self, token_id: String) -> Promise {
        let listing = self.listings.get(&token_id).expect("Token is not listed");
        assert_eq!(listing.status, "listed", "Token sale is already pending");
        assert_eq!(
            env::predecessor_account_id(),
            listing.seller,
            "Only the seller can delist"
        );
        let seller = listing.seller.clone();
        Promise::new(self.nft_contract.clone())
            .function_call(
                "nft_transfer".to_string(),
                near_sdk::serde_json::json!({
                    "receiver_id": seller,
                    "token_id": token_id,
                })
                .to_string()
                .into_bytes(),
                NearToken::from_yoctonear(1),
                Gas::from_tgas(100),
            )
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_nft_returned".to_string(),
                    near_sdk::serde_json::json!({ "token_id": token_id })
                        .to_string()
                        .into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(50),
                ),
            )
    }

    /// Callback after the NFT transfer in `delist_nft`. Private.
    #[private]
    pub fn on_nft_returned(
        &mut self,
        token_id: String,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        if result.is_ok() {
            self.listings.remove(&token_id);
        }
    }

    // ─── Death ───────────────────────────────────────────────

    /// Mark an agent dead. A dead agent cannot breed, evolve, or be
    /// killed again; its registry record stays as history.
    ///
    /// Who may kill it (a 2026-11-05 review found this callable by any
    /// account): the agent's owner, the Core owner, or — permissionless
    /// — any account once the contract has recorded enough verified
    /// failures (`consecutive_fails >= max_consecutive_fails`, via
    /// `record_fail`). The threshold path needs no trust because the
    /// failures are already onchain.
    ///
    /// What death does to money and things: the agent's `earned` total
    /// stays as history (earnings were already paid out to the owner,
    /// not held here); its NFT is untouched and still tradable; its
    /// marketplace listing, if any, is untouched; jobs it posted stay
    /// open (the poster is an account, and its escrow is refundable via
    /// `cancel_job`). A future agent ledger (available/locked balances)
    /// will define a payout on death; until then there is nothing held
    /// to return.
    pub fn die(&mut self, token_id: String) {
        let mut agent = self.agents.get(&token_id).expect("Agent not found");
        assert_eq!(agent.status, AgentStatus::Alive, "Agent already dead");
        let caller = env::predecessor_account_id();
        let threshold_met = agent.consecutive_fails >= self.max_consecutive_fails;
        assert!(
            caller == agent.owner_id || caller == self.owner_id || threshold_met,
            "Only the agent owner, the Core owner, or a verified failure threshold can kill an agent"
        );
        agent.status = AgentStatus::Dead;
        self.agents.insert(&token_id, &agent);
    }

    // ─── Admin ───────────────────────────────────────────────

    pub fn set_params(
        &mut self,
        birth_cost: U128,
        profit_threshold: U128,
        max_consecutive_fails: u32,
        min_jobs_to_reproduce: u32,
    ) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only owner");
        self.birth_cost = birth_cost;
        self.profit_threshold = profit_threshold;
        self.max_consecutive_fails = max_consecutive_fails;
        self.min_jobs_to_reproduce = min_jobs_to_reproduce;
    }

    /// Point the marketplace at a different NFT contract (owner only).
    /// Lets a mainnet deploy use its own NFT contract instead of the
    /// testnet default the code shipped with.
    pub fn set_nft_contract(&mut self, nft_contract: AccountId) {
        assert_eq!(env::predecessor_account_id(), self.owner_id, "Only owner");
        self.nft_contract = nft_contract;
    }

    // ─── Migration (v2.2 → v2.3) ─────────────────────────────────────

    /// Migrate the v2.2 state to v2.3 (review remediation). Shape changes:
    /// - `Listing` gains `status` ("listed" | "sale_pending") and `buyer`
    ///   (the marketplace state machine); every live listing converts to
    ///   "listed" with no buyer. The listings map moves to a fresh prefix
    ///   (b"M") because the value type changed.
    /// - New fields: `owner_index` (rebuilt from the agents), `nft_contract`
    ///   (the testnet default), `schema_version` (3).
    /// - `Agent` is UNCHANGED, so the agents map is carried over as-is
    ///   (prefix b"B"); wins/evolutions/jobs_done/earned are PRESERVED.
    ///   Jobs, frontiers and params are PRESERVED. MUST be the first call
    ///   after the new code is deployed.
    ///
    /// Guards (a 2026-11-05 review found these missing): only the Core
    /// owner may migrate, and a second run panics. The "already migrated"
    /// check is a dedicated storage marker key, not a trial read of the
    /// new state shape: `env::state_read::<Contract>()` PANICS (rather
    /// than returning None) when the stored bytes are the old shape, so
    /// a trial read would refuse the very migration it is guarding.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        if env::storage_read(b"genesis:migrated_v3").is_some() {
            env::panic_str("Already migrated to v2.3");
        }
        let old: OldContractV2_2 = env::state_read().expect("v2.2 state not found");
        assert_eq!(
            env::predecessor_account_id(),
            old.owner_id,
            "Only the Core owner can migrate"
        );
        // Convert listings first: inserting into the new map while
        // iterating the old one would mutate the trie mid-iteration.
        let converted: Vec<(String, Listing)> = old
            .listings
            .iter()
            .map(|(token_id, l)| {
                (
                    token_id.clone(),
                    Listing {
                        token_id: l.token_id,
                        seller: l.seller,
                        price: l.price,
                        listed_at: l.listed_at,
                        status: "listed".to_string(),
                        buyer: None,
                    },
                )
            })
            .collect();
        let mut listings = UnorderedMap::new(b"M");
        for (token_id, listing) in converted {
            listings.insert(&token_id, &listing);
        }
        // Rebuild the owner index from the agents (first token per owner).
        let mut owner_index = LookupMap::new(b"o");
        for (token_id, agent) in old.agents.iter() {
            if owner_index.get(&agent.owner_id).is_none() {
                owner_index.insert(&agent.owner_id, &token_id);
            }
        }
        let new_state = Self {
            owner_id: old.owner_id,
            treasury: old.treasury,
            agents: old.agents,
            owner_index,
            nft_contract: NFT_CONTRACT.parse().expect("bad NFT contract id"),
            schema_version: SCHEMA_VERSION,
            jobs: old.jobs,
            birth_cost: old.birth_cost,
            profit_threshold: old.profit_threshold,
            max_consecutive_fails: old.max_consecutive_fails,
            min_jobs_to_reproduce: old.min_jobs_to_reproduce,
            frontiers: old.frontiers,
            listings,
        };
        // Mark the migration done (a separate storage key, so the next
        // migrate version uses its own marker). This write lands before
        // the runtime writes the returned state.
        env::storage_write(b"genesis:migrated_v3", b"1");
        new_state
    }
}

/// The v2.2 listing state, exactly as deployed (no `status`/`buyer`).
/// Only used by `migrate()` to read the old listings and convert them.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldListingV2_2 {
    pub token_id: String,
    pub seller: AccountId,
    pub price: U128,
    pub listed_at: u64,
}

/// The v2.2 contract state, exactly as deployed. Only used by `migrate()`.
/// Field order must match the v2.2 struct (Borsh is positional). The
/// `Agent` shape is unchanged in v2.3, so it is reused directly.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldContractV2_2 {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    pub agents: UnorderedMap<String, Agent>,
    pub jobs: UnorderedMap<String, Job>,
    pub birth_cost: U128,
    pub profit_threshold: U128,
    pub max_consecutive_fails: u32,
    pub min_jobs_to_reproduce: u32,
    pub frontiers: UnorderedMap<String, Frontier>,
    pub listings: UnorderedMap<String, OldListingV2_2>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "genesisdemo354551.testnet".parse().unwrap()
    }

    fn stranger() -> AccountId {
        "mallory.testnet".parse().unwrap()
    }

    fn nft_contract() -> AccountId {
        NFT_CONTRACT.parse().unwrap()
    }

    fn testing(predecessor: AccountId) {
        // Default context: no attached deposit, and a 100 NEAR balance so
        // `pay_job`'s liabilities check (balance must cover open jobs)
        // passes. Tests that need a different balance or deposit use
        // `testing_full`.
        testing_full(predecessor, NearToken::from_near(0), NearToken::from_near(100));
    }

    fn testing_full(predecessor: AccountId, attached: NearToken, balance: NearToken) {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(predecessor);
        ctx.attached_deposit(attached);
        ctx.account_balance(balance);
        testing_env!(ctx.build());
    }

    /// Context for calling a #[private] callback (predecessor must be
    /// the contract itself).
    fn testing_as_core() {
        let mut ctx = VMContextBuilder::new();
        let core: AccountId = "core.genesisdemo354551.testnet".parse().unwrap();
        ctx.predecessor_account_id(core.clone());
        ctx.current_account_id(core);
        ctx.account_balance(NearToken::from_near(100));
        testing_env!(ctx.build());
    }

    fn empty_contract() -> Contract {
        Contract {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"a"),
            owner_index: LookupMap::new(b"o"),
            nft_contract: nft_contract(),
            schema_version: SCHEMA_VERSION,
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(0),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        }
    }

    /// Insert an agent directly (bypasses `birth`, which is gen-0-only):
    /// the scaffolding for breed/evolve tests that need a gen-2/gen-3 or
    /// gen-9 agent, or a parent with a given job history.
    fn insert_agent(c: &mut Contract, token_id: &str, owner: AccountId, generation: u32, jobs_done: u32, skill: Skill) {
        c.agents.insert(
            &token_id.to_string(),
            &Agent {
                token_id: token_id.to_string(),
                owner_id: owner.clone(),
                generation,
                parent: None,
                second_parent: None,
                skill,
                status: AgentStatus::Alive,
                jobs_done,
                consecutive_fails: 0,
                wins: jobs_done,
                evolutions: 0,
                earned: U128(0),
                created_at: 0,
            },
        );
        if c.owner_index.get(&owner).is_none() {
            c.owner_index.insert(&owner, &token_id.to_string());
        }
    }

    fn open_job(contract: &mut Contract, job_id: &str) {
        contract.jobs.insert(
            &job_id.to_string(),
            &Job {
                job_id: job_id.to_string(),
                poster: owner(),
                reward: U128(10_000_000_000_000_000_000_000),
                brief: "b".to_string(),
                keywords: vec![],
                min_words: 0,
                status: "open".to_string(),
                winner: None,
            },
        );
    }

    #[test]
    fn migrate_preserves_agents_jobs_frontier_and_listings() {
        testing(owner());
        let mut old = OldContractV2_2 {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"B"),
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(500_000_000_000_000_000_000_000),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        };
        // A gen-3 agent with real history: unlike the v2.1 → v2.2
        // migrate (which reset wins to 0 because v2.1 had none), v2.3
        // must PRESERVE wins and evolutions.
        old.agents.insert(
            &"genesis-gen-3".to_string(),
            &Agent {
                token_id: "genesis-gen-3".to_string(),
                owner_id: owner(),
                generation: 4,
                parent: Some("genesis-gen-2".to_string()),
                second_parent: None,
                skill: Skill { speed: 1.05, quality: 1.1, cost_eff: 1.05 },
                status: AgentStatus::Alive,
                jobs_done: 3,
                consecutive_fails: 0,
                wins: 3,
                evolutions: 1,
                earned: U128(30_000_000_000_000_000_000_000),
                created_at: 0,
            },
        );
        old.jobs.insert(
            &"job1".to_string(),
            &Job {
                job_id: "job1".to_string(),
                poster: owner(),
                reward: U128(10_000_000_000_000_000_000_000),
                brief: "b".to_string(),
                keywords: vec!["near".to_string()],
                min_words: 0,
                status: "open".to_string(),
                winner: None,
            },
        );
        // A live frontier and a live listing must survive the migrate —
        // wiping the frontier would reset the difficulty bar to zero.
        old.frontiers.insert(
            &"def1".to_string(),
            &Frontier {
                best_score: 554,
                best_output_hash: "h1".to_string(),
                winner: owner(),
            },
        );
        old.listings.insert(
            &"genesis-visitor-2".to_string(),
            &OldListingV2_2 {
                token_id: "genesis-visitor-2".to_string(),
                seller: "clearsite587.testnet".parse().unwrap(),
                price: U128(50_000_000_000_000_000_000_000),
                listed_at: 0,
            },
        );
        env::state_write(&old);
        let mut new = Contract::migrate();
        // The migration marker is set, so a second run refuses.
        assert!(env::storage_read(b"genesis:migrated_v3").is_some());
        assert_eq!(new.agent_count(), 1);
        let agent = new.get_agent("genesis-gen-3".to_string()).expect("agent kept");
        assert_eq!(agent.parent, Some("genesis-gen-2".to_string()));
        // Wins and evolutions are preserved this time, not reset.
        assert_eq!(agent.wins, 3);
        assert_eq!(agent.evolutions, 1);
        assert_eq!(agent.jobs_done, 3);
        assert_eq!(agent.earned.0, 30_000_000_000_000_000_000_000);
        assert!(new.get_job("job1".to_string()).is_some());
        assert_eq!(new.birth_cost.0, 500_000_000_000_000_000_000_000);
        assert_eq!(new.get_frontier("def1".to_string()).unwrap().best_score, 554);
        assert_eq!(new.get_listings().len(), 1);
        // The listing converts to the new state machine: "listed", no buyer.
        let listing = new.get_listing("genesis-visitor-2".to_string()).expect("listing kept");
        assert_eq!(listing.seller, "clearsite587.testnet".parse::<AccountId>().unwrap());
        assert_eq!(listing.status, "listed");
        assert_eq!(listing.buyer, None);
        // New fields are set.
        assert_eq!(new.schema_version, SCHEMA_VERSION);
        assert_eq!(new.nft_contract, nft_contract());
        // The owner index was rebuilt: paying the agent's owner records
        // the win on the right token.
        open_job(&mut new, "h2");
        new.pay_job("h2".to_string(), owner(), 600, "def2".to_string());
        assert_eq!(new.get_agent("genesis-gen-3".to_string()).unwrap().wins, 4);
    }

    #[test]
    #[should_panic(expected = "Only the Core owner can migrate")]
    fn migrate_rejects_a_non_owner() {
        testing(stranger());
        let old = OldContractV2_2 {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"B"),
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(0),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        };
        env::state_write(&old);
        let _ = Contract::migrate();
    }

    #[test]
    #[should_panic(expected = "Already migrated")]
    fn migrate_rejects_a_second_run() {
        testing(owner());
        // A completed migrate leaves its marker key in storage.
        env::storage_write(b"genesis:migrated_v3", b"1");
        let new = empty_contract();
        env::state_write(&new);
        let _ = Contract::migrate();
    }

    #[test]
    fn frontier_is_set_by_the_first_paying_score() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        let f = c.get_frontier("def1".to_string()).expect("frontier set");
        assert_eq!(f.best_score, 400);
        assert_eq!(f.best_output_hash, "h1");
        assert_eq!(c.get_job("h1".to_string()).unwrap().status, "paid");
    }

    #[test]
    #[should_panic(expected = "does not beat the frontier")]
    fn frontier_rejects_a_score_that_does_not_beat_it() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        open_job(&mut c, "h2");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        // 400 again does not beat 400; the job must stay open.
        c.pay_job("h2".to_string(), owner(), 400, "def1".to_string());
    }

    #[test]
    fn frontier_advances_on_a_better_score() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        open_job(&mut c, "h2");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        c.pay_job("h2".to_string(), owner(), 401, "def1".to_string());
        assert_eq!(
            c.get_frontier("def1".to_string()).unwrap().best_score,
            401
        );
    }

    #[test]
    fn get_jobs_lists_every_job() {
        testing(owner());
        let mut c = empty_contract();
        assert!(c.get_jobs().is_empty());
        open_job(&mut c, "h1");
        open_job(&mut c, "h2");
        let jobs = c.get_jobs();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().any(|j| j.job_id == "h1" && j.status == "open"));
        assert!(jobs.iter().any(|j| j.job_id == "h2" && j.status == "open"));
        // A paid job still shows up (status "paid"), so the board can
        // show history as well as open work.
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        let jobs = c.get_jobs();
        assert_eq!(jobs.len(), 2);
        assert!(jobs.iter().any(|j| j.job_id == "h1" && j.status == "paid"));
    }

    #[test]
    fn get_paid_to_sums_only_paid_jobs_for_that_winner() {
        testing(owner());
        let mut c = empty_contract();
        let other: AccountId = "gen2.genesisdemo354551.testnet".parse().unwrap();
        open_job(&mut c, "h1");
        open_job(&mut c, "h2");
        open_job(&mut c, "h3");
        // Nothing paid yet: both accounts are at zero.
        assert_eq!(c.get_paid_to(owner()).0, 0);
        assert_eq!(c.get_paid_to(other.clone()).0, 0);
        // Pay h1 to the owner (0.01 NEAR) and h2 to the other account.
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        c.pay_job("h2".to_string(), other.clone(), 401, "def1".to_string());
        // h3 is still open: it must not count for anyone.
        assert_eq!(c.get_paid_to(owner()).0, 10_000_000_000_000_000_000_000);
        assert_eq!(c.get_paid_to(other.clone()).0, 10_000_000_000_000_000_000_000);
        assert_eq!(c.get_paid_to("nobody.testnet".parse().unwrap()).0, 0);
    }

    fn two_parents(c: &mut Contract) {
        // Parent 1: gen 2, fast but lower quality. Parent 2: gen 3,
        // slower but higher quality. The child should mix both.
        // Both have 3 completed jobs, so they pass the breed eligibility
        // rule (min_jobs_to_reproduce = 3).
        insert_agent(c, "genesis-gen-2", owner(), 2, 3, Skill { speed: 1.0, quality: 1.2, cost_eff: 0.8 });
        insert_agent(c, "genesis-gen-3", owner(), 3, 3, Skill { speed: 1.4, quality: 1.0, cost_eff: 1.0 });
    }

    #[test]
    fn breed_creates_a_child_with_both_parents_and_mixed_skills() {
        testing(owner());
        let mut c = empty_contract();
        two_parents(&mut c);
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
        let child = c.get_agent("genesis-gen-4".to_string()).expect("child bred");
        // Generation is max(parent generations) + 1.
        assert_eq!(child.generation, 4);
        assert_eq!(child.parent, Some("genesis-gen-2".to_string()));
        assert_eq!(child.second_parent, Some("genesis-gen-3".to_string()));
        assert_eq!(child.status, AgentStatus::Alive);
        assert_eq!(child.jobs_done, 0);
        assert_eq!(child.earned.0, 0);
        // Each skill is the average of the two parents plus a small
        // mutation (delta in [-0.05, +0.14] per skill).
        let avg = |a: f32, b: f32| (a + b) / 2.0;
        for (child_skill, a, b) in [
            (child.skill.speed, 1.0, 1.4),
            (child.skill.quality, 1.2, 1.0),
            (child.skill.cost_eff, 0.8, 1.0),
        ] {
            let m = avg(a, b);
            assert!(child_skill >= m - 0.05 && child_skill <= m + 0.14, "skill {child_skill} outside [{:.2}, {:.2}]", m - 0.05, m + 0.14);
            assert!((child_skill - a).abs() > 0.001 || (child_skill - b).abs() > 0.001, "child must not be an exact copy of one parent");
        }
        assert_eq!(c.agent_count(), 3);
    }

    #[test]
    #[should_panic(expected = "Parent 2 not registered")]
    fn breed_rejects_an_unregistered_parent() {
        testing(owner());
        let mut c = empty_contract();
        two_parents(&mut c);
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-missing".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "is not alive")]
    fn breed_rejects_a_dead_parent() {
        testing(owner());
        let mut c = empty_contract();
        two_parents(&mut c);
        c.die("genesis-gen-3".to_string());
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Agent already exists")]
    fn breed_rejects_a_duplicate_token() {
        testing(owner());
        let mut c = empty_contract();
        two_parents(&mut c);
        c.breed(
            "genesis-gen-3".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Must attach exactly birth_cost")]
    fn breed_rejects_when_birth_cost_is_not_attached() {
        testing(owner());
        let mut c = empty_contract();
        two_parents(&mut c);
        // Set the birth cost after the parents are born (their births
        // attached nothing, so they only work while the cost is 0).
        c.birth_cost = U128(500_000_000_000_000_000_000_000);
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
    }

    /// Pay the owner `n` jobs (each on its own job definition, so the
    /// frontier never blocks). Returns the agent after the wins.
    fn win_jobs(c: &mut Contract, n: u32, def_prefix: &str) {
        for i in 0..n {
            let job_id = format!("w{}{}", def_prefix, i);
            open_job(c, &job_id);
            c.pay_job(job_id, owner(), 400 + i, format!("{}{}", def_prefix, i));
        }
    }

    #[test]
    fn pay_job_records_a_win_on_the_winners_agent() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        open_job(&mut c, "h1");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        let agent = c.get_agent("genesis-gen-0".to_string()).expect("agent");
        assert_eq!(agent.wins, 1);
        assert_eq!(agent.jobs_done, 1);
        assert_eq!(agent.earned.0, 10_000_000_000_000_000_000_000);
        assert_eq!(agent.evolutions, 0);
    }

    #[test]
    fn pay_job_ignores_a_winner_who_is_not_a_registered_agent() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        let stranger: AccountId = "nobody.testnet".parse().unwrap();
        c.pay_job("h1".to_string(), stranger, 400, "def1".to_string());
        assert_eq!(c.get_job("h1".to_string()).unwrap().status, "paid");
        assert_eq!(c.agent_count(), 0);
    }

    #[test]
    fn evolve_after_three_wins_raises_generation_and_skills() {
        testing(owner());
        let mut c = empty_contract();
        c.birth(
            "genesis-gen-0".to_string(),
            owner(),
            0,
            None,
            Some(Skill { speed: 1.0, quality: 1.0, cost_eff: 1.0 }),
        );
        win_jobs(&mut c, 3, "a");
        c.evolve("genesis-gen-0".to_string());
        let agent = c.get_agent("genesis-gen-0".to_string()).expect("agent");
        assert_eq!(agent.generation, 1);
        assert_eq!(agent.evolutions, 1);
        assert_eq!(agent.wins, 3);
        // Gen 1 is smarter than gen 0: quality +0.1, speed +0.05,
        // cost_eff +0.05.
        assert!((agent.skill.quality - 1.1).abs() < 0.001);
        assert!((agent.skill.speed - 1.05).abs() < 0.001);
        assert!((agent.skill.cost_eff - 1.05).abs() < 0.001);
    }

    #[test]
    #[should_panic(expected = "needs more wins")]
    fn evolve_rejects_before_three_wins() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        win_jobs(&mut c, 2, "a");
        c.evolve("genesis-gen-0".to_string());
    }

    #[test]
    #[should_panic(expected = "already at the final generation")]
    fn evolve_rejects_at_the_final_generation() {
        testing(owner());
        let mut c = empty_contract();
        // A gen-9 agent cannot be born (birth is gen-0-only), so the
        // fixture is inserted directly.
        insert_agent(&mut c, "genesis-gen-9", owner(), 9, 30, Skill::default());
        c.evolve("genesis-gen-9".to_string());
    }

    #[test]
    #[should_panic(expected = "is not alive")]
    fn evolve_rejects_a_dead_agent() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        win_jobs(&mut c, 3, "a");
        c.die("genesis-gen-0".to_string());
        c.evolve("genesis-gen-0".to_string());
    }

    #[test]
    fn evolve_needs_three_more_wins_for_the_next_generation() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        win_jobs(&mut c, 3, "a");
        c.evolve("genesis-gen-0".to_string());
        // 3 wins earned gen 1, but gen 2 needs 6 total wins.
        let status = c.get_evolve_status("genesis-gen-0".to_string()).expect("status");
        assert_eq!(status.generation, 1);
        assert_eq!(status.wins_needed, 3);
        assert!(!status.can_evolve);
        win_jobs(&mut c, 3, "b");
        c.evolve("genesis-gen-0".to_string());
        let agent = c.get_agent("genesis-gen-0".to_string()).expect("agent");
        assert_eq!(agent.generation, 2);
        assert_eq!(agent.evolutions, 2);
        assert_eq!(agent.wins, 6);
        // Gen 2 is smarter than gen 1.
        assert!((agent.skill.quality - 1.2).abs() < 0.001);
    }

    #[test]
    fn get_evolve_status_reports_wins_needed() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        let status = c.get_evolve_status("genesis-gen-0".to_string()).expect("status");
        assert_eq!(status.wins, 0);
        assert_eq!(status.wins_needed, 3);
        assert!(!status.can_evolve);
        assert_eq!(status.max_generation, 9);
        win_jobs(&mut c, 1, "a");
        let status = c.get_evolve_status("genesis-gen-0".to_string()).expect("status");
        assert_eq!(status.wins_needed, 2);
        win_jobs(&mut c, 2, "b");
        let status = c.get_evolve_status("genesis-gen-0".to_string()).expect("status");
        assert_eq!(status.wins_needed, 0);
        assert!(status.can_evolve);
        assert!(c.get_evolve_status("genesis-missing".to_string()).is_none());
    }

    #[test]
    fn nft_on_transfer_records_a_listing() {
        testing(nft_contract());
        let mut c = empty_contract();
        let accepted = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "1000000000000000000000000".to_string(),
        );
        // Accepted listings return false: false means "keep the token here"
        // (near-contract-standards reads the bool as `must_revert`).
        assert!(matches!(accepted, PromiseOrValue::Value(false)));
        let listing = c.get_listing("genesis-gen-2".to_string()).expect("listed");
        assert_eq!(listing.seller, owner());
        assert_eq!(listing.price.0, 1_000_000_000_000_000_000_000_000);
        assert_eq!(listing.status, "listed");
        assert_eq!(listing.buyer, None);
        assert_eq!(c.get_listings().len(), 1);
    }

    #[test]
    fn nft_on_transfer_rejects_a_bad_price() {
        testing(nft_contract());
        let mut c = empty_contract();
        let accepted = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "not-a-price".to_string(),
        );
        // A bad price returns true: true means "return the token to the sender".
        assert!(matches!(accepted, PromiseOrValue::Value(true)));
        assert!(c.get_listings().is_empty());
    }

    #[test]
    fn nft_on_transfer_overwrites_a_stale_listing() {
        testing(nft_contract());
        let mut c = empty_contract();
        let first = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "1000".to_string(),
        );
        assert!(matches!(first, PromiseOrValue::Value(false)));
        // Re-listing the same token (the stale case: the seller still owns
        // it) overwrites the old price instead of panicking.
        let second = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "2000".to_string(),
        );
        assert!(matches!(second, PromiseOrValue::Value(false)));
        let listing = c.get_listing("genesis-gen-2".to_string()).expect("listed");
        assert_eq!(listing.price.0, 2000);
        assert_eq!(c.get_listings().len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the NFT contract")]
    fn nft_on_transfer_rejects_a_direct_call() {
        testing(owner());
        let mut c = empty_contract();
        let _ = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "1000".to_string(),
        );
    }

    // ─── Review remediation: birth ─────────────────────────────

    #[test]
    #[should_panic(expected = "gen 0 only")]
    fn birth_rejects_a_forged_generation() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-2".to_string(), owner(), 2, None, None);
    }

    #[test]
    #[should_panic(expected = "Only the agent owner or the Core owner")]
    fn birth_rejects_a_foreign_owner() {
        testing(stranger());
        let mut c = empty_contract();
        // A stranger cannot register an agent owned by someone else.
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
    }

    #[test]
    #[should_panic(expected = "inside [0.5, 2.0]")]
    fn birth_rejects_out_of_range_skills() {
        testing(owner());
        let mut c = empty_contract();
        c.birth(
            "genesis-gen-0".to_string(),
            owner(),
            0,
            None,
            Some(Skill { speed: 5.0, quality: 1.0, cost_eff: 1.0 }),
        );
    }

    #[test]
    #[should_panic(expected = "no parent")]
    fn birth_rejects_a_parent() {
        testing(owner());
        let mut c = empty_contract();
        c.birth(
            "genesis-gen-0".to_string(),
            owner(),
            0,
            Some("genesis-gen-0".to_string()),
            None,
        );
    }

    #[test]
    #[should_panic(expected = "exactly birth_cost")]
    fn birth_rejects_an_overpayment() {
        testing_full(owner(), NearToken::from_near(1), NearToken::from_near(100));
        let mut c = empty_contract();
        c.birth_cost = U128(500_000_000_000_000_000_000_000);
        // Attaching 1 NEAR when the cost is 0.5: the excess used to
        // stay in the contract. Now it panics.
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
    }

    // ─── Review remediation: death ─────────────────────────────

    #[test]
    #[should_panic(expected = "Only the agent owner, the Core owner, or a verified failure threshold")]
    fn die_rejects_a_stranger() {
        testing(stranger());
        let mut c = empty_contract();
        insert_agent(&mut c, "genesis-gen-0", owner(), 0, 0, Skill::default());
        c.die("genesis-gen-0".to_string());
    }

    #[test]
    fn die_allows_the_owner() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        c.die("genesis-gen-0".to_string());
        assert_eq!(c.get_agent("genesis-gen-0".to_string()).unwrap().status, AgentStatus::Dead);
    }

    #[test]
    fn die_allows_anyone_after_verified_failures() {
        testing(stranger());
        let mut c = empty_contract();
        insert_agent(&mut c, "genesis-gen-0", owner(), 0, 0, Skill::default());
        // Three verified failures recorded onchain (by the owner/verifier
        // beforehand — set directly here because `record_fail` is
        // owner-only and this test's caller is the stranger).
        let mut agent = c.get_agent("genesis-gen-0".to_string()).unwrap();
        agent.consecutive_fails = 3;
        c.agents.insert(&"genesis-gen-0".to_string(), &agent);
        // The threshold is met, so the death needs no trust: a stranger
        // may kill the agent. (With 0 fails the same call panics — see
        // `die_rejects_a_stranger`.)
        c.die("genesis-gen-0".to_string());
        assert_eq!(c.get_agent("genesis-gen-0".to_string()).unwrap().status, AgentStatus::Dead);
    }

    #[test]
    #[should_panic(expected = "Only owner can record failures")]
    fn record_fail_is_owner_only() {
        testing(stranger());
        let mut c = empty_contract();
        insert_agent(&mut c, "genesis-gen-0", owner(), 0, 0, Skill::default());
        c.record_fail("genesis-gen-0".to_string());
    }

    #[test]
    fn a_win_resets_the_failure_streak() {
        testing(owner());
        let mut c = empty_contract();
        c.birth("genesis-gen-0".to_string(), owner(), 0, None, None);
        c.record_fail("genesis-gen-0".to_string());
        c.record_fail("genesis-gen-0".to_string());
        assert_eq!(c.get_agent("genesis-gen-0".to_string()).unwrap().consecutive_fails, 2);
        open_job(&mut c, "h1");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        assert_eq!(c.get_agent("genesis-gen-0".to_string()).unwrap().consecutive_fails, 0);
    }

    // ─── Review remediation: settlement ────────────────────────

    #[test]
    #[should_panic(expected = "does not cover open job liabilities")]
    fn pay_job_rejects_when_balance_does_not_cover_liabilities() {
        // 0.005 NEAR held, 0.01 NEAR owed to the open job.
        testing_full(owner(), NearToken::from_near(0), NearToken::from_yoctonear(5_000_000_000_000_000_000_000));
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
    }

    #[test]
    #[should_panic(expected = "Job is not open")]
    fn pay_job_rejects_a_duplicate_settlement() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        c.pay_job("h1".to_string(), owner(), 400, "def1".to_string());
        // Second settlement of the same job: no double payment.
        c.pay_job("h1".to_string(), owner(), 401, "def1".to_string());
    }

    #[test]
    fn cancel_job_releases_the_escrow() {
        testing(owner());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        assert_eq!(c.get_open_liabilities().0, 10_000_000_000_000_000_000_000);
        c.cancel_job("h1".to_string());
        assert_eq!(c.get_job("h1".to_string()).unwrap().status, "cancelled");
        assert_eq!(c.get_open_liabilities().0, 0);
    }

    #[test]
    #[should_panic(expected = "Only the job poster or the Core owner")]
    fn cancel_job_rejects_a_stranger() {
        testing(stranger());
        let mut c = empty_contract();
        open_job(&mut c, "h1");
        c.cancel_job("h1".to_string());
    }

    // ─── Review remediation: breeding and evolution ────────────

    #[test]
    #[should_panic(expected = "Only a parent's owner or the Core owner")]
    fn breed_rejects_a_stranger() {
        testing(stranger());
        let mut c = empty_contract();
        two_parents(&mut c);
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "not completed enough jobs")]
    fn breed_rejects_a_parent_with_too_few_jobs() {
        testing(owner());
        let mut c = empty_contract();
        // Both parents are unproven (0 completed jobs).
        insert_agent(&mut c, "genesis-gen-2", owner(), 2, 0, Skill::default());
        insert_agent(&mut c, "genesis-gen-3", owner(), 3, 0, Skill::default());
        c.breed(
            "genesis-gen-4".to_string(),
            owner(),
            "genesis-gen-2".to_string(),
            "genesis-gen-3".to_string(),
        );
    }

    #[test]
    #[should_panic(expected = "Only the agent owner or the Core owner")]
    fn evolve_rejects_a_stranger() {
        testing(stranger());
        let mut c = empty_contract();
        insert_agent(&mut c, "genesis-gen-0", owner(), 0, 3, Skill::default());
        c.evolve("genesis-gen-0".to_string());
    }

    // ─── Review remediation: marketplace recovery ──────────────

    fn list_token(c: &mut Contract, token_id: &str, price: u128) {
        c.listings.insert(
            &token_id.to_string(),
            &Listing {
                token_id: token_id.to_string(),
                seller: owner(),
                price: U128(price),
                listed_at: 0,
                status: "listed".to_string(),
                buyer: None,
            },
        );
    }

    #[test]
    fn buy_nft_moves_the_listing_to_sale_pending() {
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        testing_full(buyer.clone(), NearToken::from_yoctonear(1000), NearToken::from_near(100));
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        let _ = c.buy_nft("genesis-gen-2".to_string());
        let listing = c.get_listing("genesis-gen-2".to_string()).expect("listing kept");
        assert_eq!(listing.status, "sale_pending");
        assert_eq!(listing.buyer, Some(buyer));
    }

    #[test]
    #[should_panic(expected = "already pending")]
    fn buy_nft_rejects_a_second_buy_while_a_sale_is_pending() {
        let buyer: AccountId = "buyer.testnet".parse().unwrap();
        testing_full(buyer, NearToken::from_yoctonear(1000), NearToken::from_near(100));
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        let _ = c.buy_nft("genesis-gen-2".to_string());
        // The listing is sale_pending now: a second buy panics instead
        // of issuing a second transfer.
        let _ = c.buy_nft("genesis-gen-2".to_string());
    }

    #[test]
    fn failed_transfer_restores_the_listing() {
        testing_as_core();
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        // Simulate the buy having moved the listing to sale_pending.
        let mut listing = c.get_listing("genesis-gen-2".to_string()).unwrap();
        listing.status = "sale_pending".to_string();
        listing.buyer = Some("buyer.testnet".parse().unwrap());
        c.listings.insert(&"genesis-gen-2".to_string(), &listing);
        // The NFT transfer failed: the callback restores the listing.
        c.on_nft_sold(
            "genesis-gen-2".to_string(),
            owner(),
            "buyer.testnet".parse().unwrap(),
            U128(1000),
            Err(PromiseError::Failed),
        );
        let listing = c.get_listing("genesis-gen-2".to_string()).expect("listing restored");
        assert_eq!(listing.status, "listed");
        assert_eq!(listing.buyer, None);
        assert_eq!(listing.seller, owner());
    }

    #[test]
    #[should_panic(expected = "No sale is pending")]
    fn duplicate_sale_callback_does_not_pay_twice() {
        testing_as_core();
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        let mut listing = c.get_listing("genesis-gen-2".to_string()).unwrap();
        listing.status = "sale_pending".to_string();
        listing.buyer = Some("buyer.testnet".parse().unwrap());
        c.listings.insert(&"genesis-gen-2".to_string(), &listing);
        c.on_nft_sold(
            "genesis-gen-2".to_string(),
            owner(),
            "buyer.testnet".parse().unwrap(),
            U128(1000),
            Err(PromiseError::Failed),
        );
        // The first callback restored the listing to "listed", so a
        // duplicate callback finds no pending sale and panics instead
        // of refunding (or paying) a second time.
        c.on_nft_sold(
            "genesis-gen-2".to_string(),
            owner(),
            "buyer.testnet".parse().unwrap(),
            U128(1000),
            Err(PromiseError::Failed),
        );
    }

    #[test]
    fn successful_transfer_removes_the_listing() {
        testing_as_core();
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        let mut listing = c.get_listing("genesis-gen-2".to_string()).unwrap();
        listing.status = "sale_pending".to_string();
        listing.buyer = Some("buyer.testnet".parse().unwrap());
        c.listings.insert(&"genesis-gen-2".to_string(), &listing);
        c.on_nft_sold(
            "genesis-gen-2".to_string(),
            owner(),
            "buyer.testnet".parse().unwrap(),
            U128(1000),
            Ok(()),
        );
        assert!(c.get_listing("genesis-gen-2".to_string()).is_none());
    }

    #[test]
    #[should_panic(expected = "already pending")]
    fn delist_rejects_a_pending_sale() {
        testing(owner());
        let mut c = empty_contract();
        list_token(&mut c, "genesis-gen-2", 1000);
        let mut listing = c.get_listing("genesis-gen-2".to_string()).unwrap();
        listing.status = "sale_pending".to_string();
        listing.buyer = Some("buyer.testnet".parse().unwrap());
        c.listings.insert(&"genesis-gen-2".to_string(), &listing);
        let _ = c.delist_nft("genesis-gen-2".to_string());
    }

    // ─── Review remediation: admin ─────────────────────────────

    #[test]
    #[should_panic(expected = "Only owner")]
    fn set_nft_contract_is_owner_only() {
        testing(stranger());
        let mut c = empty_contract();
        c.set_nft_contract("nft.mainnet".parse().unwrap());
    }

    #[test]
    fn set_nft_contract_updates_the_marketplace() {
        testing(owner());
        let mut c = empty_contract();
        let mainnet: AccountId = "nft.mainnet".parse().unwrap();
        c.set_nft_contract(mainnet.clone());
        assert_eq!(c.nft_contract, mainnet);
    }
}
