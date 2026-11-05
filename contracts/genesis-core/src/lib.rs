//! Genesis Core — minimal on-chain rules for the agent lifecycle.
//! Designed for NEAR HACKATHON 2026 (AI Swarms / Agent Economy / NFTs That Do Something).
//!
//! Core ideas enforced on-chain:
//! - Agents are registered with generation, parent, skills and status.
//! - Birth can be funded by treasury (Gen 0) or by parent balance.
//! - Jobs can be posted with an escrow deposit.
//! - On successful verification the agent is paid from the escrow.
//! - Death returns remaining balance and marks the agent dead.
//! - Difficulty is labinius-style: a job only pays when the agent's score
//!   BEATS the frontier (the best score on that job definition, stored
//!   onchain). The bar rises every time someone beats it.
//! - Agent gen NFTs can be bought and sold in the Core's escrow marketplace:
//!   the seller sends the NFT to the Core, a buyer pays the listed price,
//!   the Core releases the NFT and pays the seller (5% fee to the treasury).

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

/// The shared NEP-171 NFT contract Genesis mints on. Only calls from this
/// account are accepted as NFT transfers into the marketplace.
pub const NFT_CONTRACT: &str = "nft.primitives.testnet";
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
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, schemars::JsonSchema, serde::Serialize, serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Listing {
    pub token_id: String,
    pub seller: AccountId,
    // U128 has no JsonSchema impl in near-sdk 5.30; see Agent.earned above.
    #[schemars(with = "String")]
    pub price: U128,           // yoctoNEAR
    pub listed_at: u64,        // block timestamp
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    pub agents: UnorderedMap<String, Agent>,
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

    /// Register a new agent. Caller must attach at least birth_cost.
    /// For Gen 0 the funds come from the caller (usually treasury).
    /// For later generations the parent must have enough earned balance
    /// (tracked off-chain for now; full parent debit can be added later).
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
        let deposit = env::attached_deposit();
        // birth_cost is 0 until the owner calls set_params after init; once
        // set (deploy script sets 0.5 NEAR), a birth must attach at least that.
        assert!(
            deposit.as_yoctonear() >= self.birth_cost.0,
            "Must attach at least birth_cost"
        );

        let agent = Agent {
            token_id: token_id.clone(),
            owner_id,
            generation,
            parent,
            second_parent: None,
            skill: skill.unwrap_or_default(),
            status: AgentStatus::Alive,
            jobs_done: 0,
            consecutive_fails: 0,
            wins: 0,
            evolutions: 0,
            earned: U128(0),
            created_at: env::block_timestamp(),
        };
        self.agents.insert(&token_id, &agent);
    }

    /// Two-parent breeding: breed two proven (registered, alive) agents
    /// into a child that combines their skills.
    ///
    /// - Both parents must exist in the registry and be alive. A dead
    ///   agent cannot breed.
    /// - The child generation is max(parent generations) + 1.
    /// - Each child skill is the average of the two parents' skills plus
    ///   a small mutation (derived from the block timestamp, clamped to
    ///   0.5–2.0), so the child is a mix of both parents, not a copy of
    ///   either one.
    /// - The caller attaches the birth cost (same as `birth`); the child
    ///   is registered with parent = parent1 and second_parent = parent2.
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
        let deposit = env::attached_deposit();
        assert!(
            deposit.as_yoctonear() >= self.birth_cost.0,
            "Must attach at least birth_cost"
        );
        let generation = std::cmp::max(p1.generation, p2.generation) + 1;
        // Small mutation from the block timestamp: a pseudo-random delta
        // in [-0.05, +0.14] per skill, so the child varies slightly from
        // the plain average of its parents.
        let t = env::block_timestamp();
        let delta = |shift: u64| -> f32 {
            (((t >> shift) % 20) as f32) / 100.0 - 0.05
        };
        let mix = |a: f32, b: f32, shift: u64| -> f32 {
            ((a + b) / 2.0 + delta(shift)).clamp(0.5, 2.0)
        };
        let skill = Skill {
            speed: mix(p1.skill.speed, p2.skill.speed, 0),
            quality: mix(p1.skill.quality, p2.skill.quality, 5),
            cost_eff: mix(p1.skill.cost_eff, p2.skill.cost_eff, 10),
        };
        let agent = Agent {
            token_id: token_id.clone(),
            owner_id,
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
    pub fn evolve(&mut self, token_id: String) {
        let mut agent = self.agents.get(&token_id).expect("Agent not found");
        assert_eq!(agent.status, AgentStatus::Alive, "Agent is not alive");
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

    /// Pay the winner of a job. Only the contract owner (or a future oracle)
    /// can call this after off-chain verification. Moves the escrowed reward
    /// to the winning agent account.
    ///
    /// Labinius rule: the score must BEAT the frontier for this job
    /// definition (job_def_id = sha256 of brief + keywords + source). The
    /// first paying score sets the frontier; a later score must be strictly
    /// higher, or this call panics and nothing is paid. The frontier is
    /// updated here, onchain, so no race can pay a beaten score.
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
        // last evolution earns the next generation. The lookup is a linear
        // scan over agents (the registry is small); a reverse owner→token
        // map is the scalable fix if the registry ever grows large.
        if let Some(token_id) = self.agent_token_for_owner(&winner) {
            if let Some(mut agent) = self.agents.get(&token_id) {
                agent.wins += 1;
                agent.jobs_done += 1;
                agent.earned = U128(agent.earned.0 + job.reward.0);
                self.agents.insert(&token_id, &agent);
            }
        }

        // Transfer the escrowed reward
        Promise::new(winner).transfer(NearToken::from_yoctonear(job.reward.0));
    }

    /// Find a registered agent's token by its owner account. Returns None
    /// when the account owns no registered agent (e.g. a human wallet
    /// that won a job). Linear scan — fine at this registry size.
    fn agent_token_for_owner(&self, owner: &AccountId) -> Option<String> {
        self.agents
            .iter()
            .find(|(_, a)| &a.owner_id == owner)
            .map(|(token_id, _)| token_id)
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
        let nft_contract: AccountId = NFT_CONTRACT.parse().expect("bad NFT contract id");
        assert_eq!(
            env::predecessor_account_id(),
            nft_contract,
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
            },
        );
        // Listing accepted: keep the token in escrow (false = do not return).
        PromiseOrValue::Value(false)
    }

    /// Buy a listed NFT. The caller must attach exactly the listing price.
    /// The NFT is transferred to the buyer first; the callback then pays
    /// the seller 95% and the Core owner (treasury) the 5% fee. If the NFT
    /// transfer fails, the buyer is refunded in full.
    #[payable]
    pub fn buy_nft(&mut self, token_id: String) -> Promise {
        let listing = self.listings.get(&token_id).expect("Token is not listed");
        let price = listing.price.0;
        let attached = env::attached_deposit().as_yoctonear();
        assert_eq!(attached, price, "Must attach exactly the listing price");
        let buyer = env::predecessor_account_id();
        let seller = listing.seller.clone();
        // Remove the listing now so the same token cannot be bought twice.
        self.listings.remove(&token_id);
        let nft_contract: AccountId = NFT_CONTRACT.parse().expect("bad NFT contract id");
        Promise::new(nft_contract)
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
    /// contract can call it.
    #[private]
    pub fn on_nft_sold(
        &mut self,
        seller: AccountId,
        buyer: AccountId,
        price: U128,
        #[callback_result] result: Result<(), PromiseError>,
    ) {
        match result {
            Ok(()) => {
                let fee = price.0 * MARKETPLACE_FEE_BPS / 10_000;
                let seller_amount = price.0 - fee;
                Promise::new(seller).transfer(NearToken::from_yoctonear(seller_amount));
                if fee > 0 {
                    Promise::new(self.owner_id.clone())
                        .transfer(NearToken::from_yoctonear(fee));
                }
            }
            Err(_) => {
                // The NFT never moved; refund the buyer in full.
                Promise::new(buyer).transfer(NearToken::from_yoctonear(price.0));
            }
        }
    }

    /// Delist an NFT. Only the seller can call it. The NFT is transferred
    /// back first; the listing is removed by the callback only when that
    /// transfer succeeds, so a failed transfer never strands the NFT.
    pub fn delist_nft(&mut self, token_id: String) -> Promise {
        let listing = self.listings.get(&token_id).expect("Token is not listed");
        assert_eq!(
            env::predecessor_account_id(),
            listing.seller,
            "Only the seller can delist"
        );
        let seller = listing.seller.clone();
        let nft_contract: AccountId = NFT_CONTRACT.parse().expect("bad NFT contract id");
        Promise::new(nft_contract)
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

    /// Mark an agent dead. Remaining balance handling is left to the caller
    /// (CLI / MCP) in this skeleton; a future version can hold agent balances
    /// inside the contract and return them automatically.
    pub fn die(&mut self, token_id: String) {
        let mut agent = self.agents.get(&token_id).expect("Agent not found");
        assert_eq!(agent.status, AgentStatus::Alive, "Agent already dead");
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

    // ─── Migration (v2.1 → v2.2) ─────────────────────────────────────

    /// Migrate the v2.1 state to v2.2 (evolution). The only shape change
    /// is `Agent.wins` and `Agent.evolutions`, so every existing agent is
    /// carried over with wins 0 and evolutions 0 (the live agents have
    /// not won any Core-paid jobs yet under v2.1 — their paid jobs predate
    /// win tracking, so they start at 0 and earn wins from here on).
    /// Frontiers, listings, jobs and params are PRESERVED. The agents map
    /// moves to a fresh prefix (b"B") for the same reason as the v2.1
    /// migrate: the value type changed again, and reusing the old prefix
    /// (b"A") makes insert panic with "Index out of bounds". MUST be the
    /// first call after the new code is deployed.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldContractV2_1 = env::state_read().expect("v2.1 state not found");
        // Collect first: inserting into the new agents map while iterating
        // the old one would mutate the trie mid-iteration.
        let converted: Vec<(String, Agent)> = old
            .agents
            .iter()
            .map(|(token_id, a)| {
                (
                    token_id.clone(),
                    Agent {
                        token_id: a.token_id,
                        owner_id: a.owner_id,
                        generation: a.generation,
                        parent: a.parent,
                        second_parent: a.second_parent,
                        skill: a.skill,
                        status: a.status,
                        jobs_done: a.jobs_done,
                        consecutive_fails: a.consecutive_fails,
                        wins: 0,
                        evolutions: 0,
                        earned: a.earned,
                        created_at: a.created_at,
                    },
                )
            })
            .collect();
        let mut agents = UnorderedMap::new(b"B");
        for (token_id, agent) in converted {
            agents.insert(&token_id, &agent);
        }
        Self {
            owner_id: old.owner_id,
            treasury: old.treasury,
            agents,
            jobs: old.jobs,
            birth_cost: old.birth_cost,
            profit_threshold: old.profit_threshold,
            max_consecutive_fails: old.max_consecutive_fails,
            min_jobs_to_reproduce: old.min_jobs_to_reproduce,
            frontiers: old.frontiers,
            listings: old.listings,
        }
    }
}

/// The v2.1 agent state, exactly as deployed (has `second_parent`, no
/// `wins`/`evolutions`). Only used by `migrate()` to read the old agents
/// and convert them.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldAgentV2 {
    pub token_id: String,
    pub owner_id: AccountId,
    pub generation: u32,
    pub parent: Option<String>,
    pub second_parent: Option<String>,
    pub skill: Skill,
    pub status: AgentStatus,
    pub jobs_done: u32,
    pub consecutive_fails: u32,
    pub earned: U128,
    pub created_at: u64,
}

/// The v2.1 contract state, exactly as deployed. Only used by `migrate()`.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldContractV2_1 {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    pub agents: UnorderedMap<String, OldAgentV2>,
    pub jobs: UnorderedMap<String, Job>,
    pub birth_cost: U128,
    pub profit_threshold: U128,
    pub max_consecutive_fails: u32,
    pub min_jobs_to_reproduce: u32,
    pub frontiers: UnorderedMap<String, Frontier>,
    pub listings: UnorderedMap<String, Listing>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn owner() -> AccountId {
        "genesisdemo354551.testnet".parse().unwrap()
    }

    fn nft_contract() -> AccountId {
        NFT_CONTRACT.parse().unwrap()
    }

    fn testing(predecessor: AccountId) {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(predecessor);
        testing_env!(ctx.build());
    }

    fn empty_contract() -> Contract {
        Contract {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"a"),
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(0),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
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
        let mut old = OldContractV2_1 {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"A"),
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(500_000_000_000_000_000_000_000),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        };
        old.agents.insert(
            &"genesis-gen-2".to_string(),
            &OldAgentV2 {
                token_id: "genesis-gen-2".to_string(),
                owner_id: owner(),
                generation: 2,
                parent: Some("genesis-gen-1".to_string()),
                second_parent: Some("genesis-gen-0".to_string()),
                skill: Skill::default(),
                status: AgentStatus::Alive,
                jobs_done: 1,
                consecutive_fails: 0,
                earned: U128(0),
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
        // the v1 migrate reset them because v1 had none; v2 does, and
        // wiping the frontier would reset the difficulty bar to zero.
        old.frontiers.insert(
            &"def1".to_string(),
            &Frontier {
                best_score: 483,
                best_output_hash: "h1".to_string(),
                winner: owner(),
            },
        );
        old.listings.insert(
            &"genesis-weak-2".to_string(),
            &Listing {
                token_id: "genesis-weak-2".to_string(),
                seller: owner(),
                price: U128(1_000_000_000_000_000_000_000),
                listed_at: 0,
            },
        );
        env::state_write(&old);
        let new = Contract::migrate();
        assert_eq!(new.agent_count(), 1);
        let agent = new.get_agent("genesis-gen-2".to_string()).expect("agent kept");
        assert_eq!(agent.parent, Some("genesis-gen-1".to_string()));
        assert_eq!(agent.second_parent, Some("genesis-gen-0".to_string()));
        assert_eq!(agent.wins, 0);
        assert_eq!(agent.evolutions, 0);
        assert!(new.get_job("job1".to_string()).is_some());
        assert_eq!(new.birth_cost.0, 500_000_000_000_000_000_000_000);
        assert_eq!(new.get_frontier("def1".to_string()).unwrap().best_score, 483);
        assert_eq!(new.get_listings().len(), 1);
        assert_eq!(new.get_listing("genesis-weak-2".to_string()).unwrap().seller, owner());
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
        c.birth(
            "genesis-gen-2".to_string(),
            owner(),
            2,
            Some("genesis-gen-1".to_string()),
            Some(Skill { speed: 1.0, quality: 1.2, cost_eff: 0.8 }),
        );
        c.birth(
            "genesis-gen-3".to_string(),
            owner(),
            3,
            Some("genesis-gen-2".to_string()),
            Some(Skill { speed: 1.4, quality: 1.0, cost_eff: 1.0 }),
        );
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
    #[should_panic(expected = "Must attach at least birth_cost")]
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
        c.birth("genesis-gen-9".to_string(), owner(), 9, None, None);
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
}
