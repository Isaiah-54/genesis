//! Genesis Core — minimal on-chain rules for the agent lifecycle.
//! Designed for NEAR HACKATHON 2026 (AI Swarms / Agent Economy / NFTs That Do Something).
//!
//! Core ideas enforced on-chain:
//! - Agents are registered with generation, parent, skills and status.
//! - Birth can be funded by treasury (Gen 0) or by parent balance.
//! - Jobs can be posted with an escrow deposit.
//! - On successful verification the agent is paid from the escrow.
//! - Death returns remaining balance and marks the agent dead.
//!
//! This is the contract skeleton. Deploy, initialize, then wire the existing
//! JS CLI / MCP / website to call these methods. The off-chain engine remains
//! the source of truth for complex verification until a full oracle path lands.

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::{
    env, near, AccountId, NearToken, PanicOnDefault, Promise, PromiseError,
};

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
    pub fn pay_job(&mut self, job_id: String, winner: AccountId) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only owner can settle jobs in this version"
        );
        let mut job = self.jobs.get(&job_id).expect("Job not found");
        assert_eq!(job.status, "open", "Job is not open");
        job.status = "paid".to_string();
        job.winner = Some(winner.clone());
        self.jobs.insert(&job_id, &job);

        // Transfer the escrowed reward
        Promise::new(winner).transfer(NearToken::from_yoctonear(job.reward.0));
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
}
