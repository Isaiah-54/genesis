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
    pub skill: Skill,
    pub status: AgentStatus,
    pub jobs_done: u32,
    pub consecutive_fails: u32,
    // U128 has no JsonSchema impl in near-sdk 5.30; it serialises as a
    // string in JSON, so declare the schema as String for the ABI.
    #[schemars(with = "String")]
    pub earned: U128,          // yoctoNEAR
    pub created_at: u64,       // block timestamp
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
            skill: skill.unwrap_or_default(),
            status: AgentStatus::Alive,
            jobs_done: 0,
            consecutive_fails: 0,
            earned: U128(0),
            created_at: env::block_timestamp(),
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

        // Transfer the escrowed reward
        Promise::new(winner).transfer(NearToken::from_yoctonear(job.reward.0));
    }

    // ─── Marketplace (escrow) ────────────────────────────────────

    /// NEP-171 receiver callback: called by the NFT contract when someone
    /// sends an NFT here with `nft_transfer_call`. The `msg` must be the
    /// listing price in yoctoNEAR as a decimal string. The NFT stays in
    /// this contract (escrow) until it is bought or delisted.
    /// Only calls from the NFT contract are accepted; anything else panics,
    /// so a listing cannot be faked by calling this method directly.
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
            _ => return PromiseOrValue::Value(false),
        };
        assert!(
            self.listings.get(&token_id).is_none(),
            "Token is already listed"
        );
        self.listings.insert(
            &token_id,
            &Listing {
                token_id: token_id.clone(),
                seller: previous_owner_id,
                price: U128(price),
                listed_at: env::block_timestamp(),
            },
        );
        PromiseOrValue::Value(true)
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

    // ─── Migration (v1 → v2) ─────────────────────────────────────

    /// Upgrade the deployed v1 contract to v2 in place, on the same account.
    /// Reads the v1 state (agents, jobs, params), writes the v2 state with
    /// empty frontiers and listings. MUST be the first call after the new
    /// code is deployed — any other method would try to read v2 state from
    /// v1 bytes and fail. Anyone can call it; it only rewrites the state
    /// into the new shape and keeps every agent, job and parameter.
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let old: OldContract = env::state_read().expect("v1 state not found");
        Self {
            owner_id: old.owner_id,
            treasury: old.treasury,
            agents: old.agents,
            jobs: old.jobs,
            birth_cost: old.birth_cost,
            profit_threshold: old.profit_threshold,
            max_consecutive_fails: old.max_consecutive_fails,
            min_jobs_to_reproduce: old.min_jobs_to_reproduce,
            frontiers: UnorderedMap::new(b"f"),
            listings: UnorderedMap::new(b"l"),
        }
    }
}

/// The v1 contract state, exactly as deployed. Only used by `migrate()`.
#[derive(BorshDeserialize, BorshSerialize)]
pub struct OldContract {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    pub agents: UnorderedMap<String, Agent>,
    pub jobs: UnorderedMap<String, Job>,
    pub birth_cost: U128,
    pub profit_threshold: U128,
    pub max_consecutive_fails: u32,
    pub min_jobs_to_reproduce: u32,
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
    fn migrate_preserves_agents_and_jobs() {
        testing(owner());
        let mut old = OldContract {
            owner_id: owner(),
            treasury: owner(),
            agents: UnorderedMap::new(b"a"),
            jobs: UnorderedMap::new(b"j"),
            birth_cost: U128(500_000_000_000_000_000_000_000),
            profit_threshold: U128(0),
            max_consecutive_fails: 3,
            min_jobs_to_reproduce: 3,
        };
        old.agents.insert(
            &"genesis-gen-2".to_string(),
            &Agent {
                token_id: "genesis-gen-2".to_string(),
                owner_id: owner(),
                generation: 2,
                parent: Some("genesis-gen-1".to_string()),
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
        env::state_write(&old);
        let new = Contract::migrate();
        assert_eq!(new.agent_count(), 1);
        assert!(new.get_agent("genesis-gen-2".to_string()).is_some());
        assert!(new.get_job("job1".to_string()).is_some());
        assert_eq!(new.birth_cost.0, 500_000_000_000_000_000_000_000);
        assert!(new.get_frontier("anything".to_string()).is_none());
        assert!(new.get_listings().is_empty());
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
    fn nft_on_transfer_records_a_listing() {
        testing(nft_contract());
        let mut c = empty_contract();
        let accepted = c.nft_on_transfer(
            owner(),
            owner(),
            "genesis-gen-2".to_string(),
            "1000000000000000000000000".to_string(),
        );
        assert!(matches!(accepted, PromiseOrValue::Value(true)));
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
        assert!(matches!(accepted, PromiseOrValue::Value(false)));
        assert!(c.get_listings().is_empty());
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
