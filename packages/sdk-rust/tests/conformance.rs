//! Conformance: the Rust SDK against the shared protocol fixtures (the same files every SDK runs).
use std::collections::HashMap;
use std::path::PathBuf;

use flurbo_sdk::abi::{decode_call, decode_pool_log, decode_words, encode_call, selector, Arg, Log, PoolEvent};
use flurbo_sdk::amounts::{buy_limit, frechet_bounds, joint_from_pair, parse_atoms, percent_to_ppm, sell_minimum, trunc_div, PPM};
use flurbo_sdk::claims::{claim_key, claim_valid, decode_claim, encode_claim, payout_fraction, Leg};
use flurbo_sdk::effects::{verify_effect, EffectIntent};
use flurbo_sdk::policy::{effective_policy, evaluate_policy, FlurboPolicy, LocalPolicy, PolicyInput};
use flurbo_sdk::recovery::{recovery_step, ChainView, RecoveryEntry};
use flurbo_sdk::research::{validate_model_output, Evidence, EvidenceRequirement, Validation, ValidationContext};
use flurbo_sdk::signer::{to_hex, transaction_hash, unsigned_serialized, LocalKeySigner, Signer, Tx1559};
use flurbo_sdk::strategy::{candidate_claims, decide, JointForecast, Quote, StrategyConfig, StrategyMarket};
use flurbo_sdk::u256::U256;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocol/fixtures").join(format!("{}.json", name));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn i(v: &Value) -> i128 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        _ => v.as_i64().unwrap() as i128,
    }
}

fn legs(v: &Value) -> Vec<Leg> {
    serde_json::from_value(v.clone()).unwrap()
}

#[test]
fn claims() {
    let f = fixture("claims");
    for c in f["encode"].as_array().unwrap() {
        let (scope, mask) = encode_claim(c["events"].as_i64().unwrap(), &legs(&c["legs"]), c["rule"].as_str().unwrap()).unwrap();
        assert_eq!((json!(scope), json!(mask.to_string())), (c["scope"].clone(), c["mask"].clone()), "{}", c);
    }
    for c in f["invalidEncode"].as_array().unwrap() {
        assert!(encode_claim(c["events"].as_i64().unwrap(), &legs(&c["legs"]), c["rule"].as_str().unwrap()).is_err(), "{}", c);
    }
    for c in f["validate"].as_array().unwrap() {
        assert_eq!(claim_valid(c["scope"].as_i64().unwrap(), c["mask"].as_str().unwrap(), c["events"].as_i64().unwrap()), c["valid"].as_bool().unwrap(), "{}", c);
    }
    for c in f["decode"].as_array().unwrap() {
        let named = decode_claim(c["scope"].as_i64().unwrap(), c["mask"].as_str().unwrap(), c["events"].as_i64().unwrap()).unwrap();
        let got = match named {
            Some((rule, l)) => json!({"rule": rule, "legs": l}),
            None => json!({"rule": "OTHER", "legs": null}),
        };
        assert_eq!(got, json!({"rule": c["rule"], "legs": c["legs"]}), "{}", c);
    }
    for k in f["keys"].as_array().unwrap() {
        let key = claim_key(k["chainId"].as_u64().unwrap(), k["pool"].as_str().unwrap(), k["scope"].as_u64().unwrap() as u32, i(&k["mask"]) as u32);
        assert_eq!(key, k["key"].as_str().unwrap());
    }
    for p in f["payouts"].as_array().unwrap() {
        let u = |k: &str| p[k].as_u64().unwrap() as u32;
        let (n, d) = payout_fraction(u("scope"), i(&p["mask"]) as u32, u("events"), u("yesMask"), u("voidMask")).unwrap();
        let payout = i(&p["quantityAtoms"]) * n as i128 / d as i128;
        assert_eq!(
            (n.to_string(), d.to_string(), payout.to_string()),
            (p["numerator"].as_str().unwrap().into(), p["denominator"].as_str().unwrap().into(), p["payoutAtoms"].as_str().unwrap().into()),
            "{}",
            p
        );
    }
}

fn arg(v: &Value) -> Arg {
    match v {
        Value::String(s) if s.starts_with("0x") => Arg::Text(s.clone()),
        Value::String(s) => Arg::Text(s.clone()),
        Value::Number(n) => Arg::Uint(U256::from_u128(n.as_u64().unwrap() as u128)),
        Value::Bool(b) => Arg::Bool(*b),
        _ => panic!("unexpected argument"),
    }
}

fn word_of(v: &Value) -> U256 {
    match v {
        Value::String(s) if s.starts_with("0x") => U256::from_hex(s).unwrap(),
        Value::String(s) => U256::from_dec(s).unwrap(),
        _ => U256::from_u128(v.as_u64().unwrap() as u128),
    }
}

fn log_of(v: &Value) -> Log {
    Log { address: v["address"].as_str().unwrap().into(), topics: v["topics"].as_array().unwrap().iter().map(|t| t.as_str().unwrap().to_string()).collect(), data: v["data"].as_str().unwrap().into() }
}

#[test]
fn calldata_returns_and_events() {
    let f = fixture("calldata");
    for c in f["calls"].as_array().unwrap() {
        let name = c["function"].as_str().unwrap();
        let args: Vec<Arg> = c["args"].as_array().unwrap().iter().map(arg).collect();
        assert_eq!(encode_call(name, &args).unwrap(), c["data"].as_str().unwrap(), "{}", c);
        let (decoded, words) = decode_call(c["data"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, name);
        assert_eq!(words, c["args"].as_array().unwrap().iter().map(word_of).collect::<Vec<_>>());
    }
    for (name, sel) in f["selectors"].as_object().unwrap() {
        assert_eq!(selector(name), sel.as_str());
    }
    let first = f["calls"][0]["data"].as_str().unwrap();
    assert!(decode_call(&format!("{}00", first)).unwrap_err().message.contains("length"));
    assert!(decode_call(&format!("0x3e6b6cde{}{}", "f".repeat(64), &first[74..])).unwrap_err().message.contains("Non-canonical"));
    let too_big = encode_call("buy", &[3u32.into(), 8u32.into(), "340282366920938463463374607431768211456".into(), 1u32.into(), 1u32.into()]);
    assert!(too_big.unwrap_err().message.contains("out of range"));
    for r in f["returns"].as_array().unwrap() {
        let data = r["data"].as_str().unwrap();
        match r["function"].as_str().unwrap() {
            "payoutFraction" => assert_eq!(json!(decode_words(data, 2).unwrap().iter().map(|w| w.to_dec()).collect::<Vec<_>>()), r["value"]),
            "resolved" => assert_eq!(json!(!decode_words(data, 1).unwrap()[0].is_zero()), r["value"]),
            _ => assert_eq!(json!(decode_words(data, 1).unwrap()[0].to_dec()), r["value"]),
        }
    }
    for e in f["events"].as_array().unwrap() {
        let got = match decode_pool_log(&log_of(e)).unwrap() {
            PoolEvent::Traded { trader, scope, mask, is_buy, quantity, collateral_amount, .. } => json!({"event": "Traded", "trader": trader, "scope": scope, "mask": mask.to_dec(),
                "isBuy": is_buy, "quantity": quantity.to_string(), "collateralAmount": collateral_amount.to_string()}),
            PoolEvent::Redeemed { owner, scope, mask, quantity, collateral_amount, .. } => json!({"event": "Redeemed", "owner": owner, "scope": scope, "mask": mask.to_dec(),
                "quantity": quantity.to_string(), "collateralAmount": collateral_amount.to_string()}),
        };
        assert_eq!(got, e["decoded"]);
    }
}

#[test]
fn amounts() {
    let f = fixture("amounts");
    for p in f["parse"].as_array().unwrap() {
        assert_eq!(parse_atoms(p["text"].as_str().unwrap(), "amount").is_ok(), p["valid"].as_bool().unwrap(), "{}", p);
    }
    for l in f["limits"].as_array().unwrap() {
        let (q, bps) = (i(&l["quoteAtoms"]), i(&l["slippageBps"]));
        assert_eq!(buy_limit(q, bps), i(&l["buyLimitAtoms"]));
        assert_eq!(sell_minimum(q, bps), i(&l["sellMinimumAtoms"]));
    }
    for e in f["edges"].as_array().unwrap() {
        let worst = buy_limit(i(&e["quoteAtoms"]), i(&e["slippageBps"]));
        let expected = i(&e["quantityAtoms"]) * i(&e["claimPpm"]) / PPM;
        let edge = expected - worst;
        assert_eq!([worst, expected, edge, trunc_div(edge * 10_000, worst)], [i(&e["worstCostAtoms"]), i(&e["expectedPayoutAtoms"]), i(&e["edgeAtoms"]), i(&e["edgeBps"])]);
    }
    for p in f["percent"].as_array().unwrap() {
        let got = percent_to_ppm(p["text"].as_str().unwrap()).ok().map(|v| v.to_string());
        assert_eq!(json!(got), p["ppm"], "{}", p);
    }
    for c in f["frechet"].as_array().unwrap() {
        let (a, b, both) = (i(&c["pA"]), i(&c["pB"]), i(&c["pBoth"]));
        assert_eq!(frechet_bounds(a, b).unwrap(), (i(&c["lowPpm"]), i(&c["highPpm"])));
        let joint = joint_from_pair(0, 1, a, b, both);
        assert_eq!(joint.is_ok(), c["valid"].as_bool().unwrap());
        if let Ok((_, states)) = joint {
            assert_eq!(json!(states.iter().map(|s| s.to_string()).collect::<Vec<_>>()), c["statesPpm"]);
        }
    }
}

#[test]
fn policy() {
    let f = fixture("policy");
    for c in f["cases"].as_array().unwrap() {
        let input: PolicyInput = serde_json::from_value(c["input"].clone()).unwrap_or_else(|e| panic!("{}: {}", c["name"], e));
        assert_eq!(json!(evaluate_policy(&input).violations), c["expect"], "{}", c["name"]);
    }
    for e in f["effective"].as_array().unwrap() {
        let local: LocalPolicy = serde_json::from_value(e["local"].clone()).unwrap();
        let flurbo: Option<FlurboPolicy> = serde_json::from_value(e["flurbo"].clone()).unwrap();
        let got = effective_policy(&local, flurbo.as_ref(), e["readAt"].as_i64(), e["now"].as_i64().unwrap(), e["policyMaxAgeSeconds"].as_i64().unwrap());
        assert_eq!(serde_json::to_value(got).unwrap(), e["expect"], "{}", e["name"]);
    }
}

#[test]
fn recovery_and_effects() {
    let f = fixture("recovery");
    for t in f["transitions"].as_array().unwrap() {
        let entry: RecoveryEntry = serde_json::from_value(t["entry"].clone()).unwrap();
        let chain: ChainView = serde_json::from_value(t["chain"].clone()).unwrap();
        assert_eq!(serde_json::to_value(recovery_step(&entry, &chain, t["now"].as_i64().unwrap())).unwrap(), t["expect"], "{}", t["name"]);
    }
    for e in f["effects"].as_array().unwrap() {
        let intent: EffectIntent = serde_json::from_value(e["intent"].clone()).unwrap();
        let logs: Vec<Log> = e["receipt"]["logs"].as_array().unwrap().iter().map(log_of).collect();
        let got = verify_effect(&intent, e["receipt"]["status"].as_u64().unwrap() as u8, &logs, e["allowanceAfterAtoms"].as_str());
        let got = if got.status == "confirmed" { json!({"status": "confirmed", "collateralAtoms": got.collateral_atoms.map(|a| a.to_string())}) } else { json!({"status": got.status}) };
        assert_eq!(got, e["expect"], "{}", e["name"]);
    }
}

#[test]
fn research() {
    let f = fixture("research");
    for c in f["cases"].as_array().unwrap() {
        let mut ctx = f["context"].clone();
        if let Some(overrides) = c["context"].as_object() {
            ctx.as_object_mut().unwrap().extend(overrides.clone());
        }
        let evidence: Vec<Evidence> = serde_json::from_value(ctx["evidence"].clone()).unwrap();
        let requested: Vec<u32> = serde_json::from_value(ctx["requestedEvents"].clone()).unwrap();
        let requirements: Vec<EvidenceRequirement> = serde_json::from_value(ctx.get("evidenceRequirements").cloned().unwrap_or(json!([]))).unwrap();
        let vctx = ValidationContext {
            requested_events: &requested,
            event_count: ctx["eventCount"].as_u64().unwrap() as u32,
            evidence: &evidence,
            now: ctx["now"].as_i64().unwrap(),
            max_evidence_age_seconds: ctx["maxEvidenceAgeSeconds"].as_i64().unwrap(),
            evidence_requirements: &requirements,
        };
        let got = match validate_model_output(c["output"].as_str().unwrap(), &vctx) {
            Validation::Ok(o) => json!({"status": "ok", "statesPpm": o.states_ppm.iter().map(|p| *p as i64).collect::<Vec<_>>(), "evidenceIds": o.evidence_ids}),
            Validation::Abstain { reason, model_reason: Some(m) } => json!({"status": "abstain", "reason": reason, "modelReason": m}),
            Validation::Abstain { reason, model_reason: None } => json!({"status": "abstain", "reason": reason}),
        };
        assert_eq!(got, c["expect"], "{}", c["name"]);
    }
}

#[test]
fn strategy() {
    let f = fixture("strategy");
    for c in f["cases"].as_array().unwrap() {
        let (m, fc, cfg, x) = (&c["market"], &c["forecast"], &c["config"], &c["expect"]);
        let market = StrategyMarket {
            pool: m["pool"].as_str().unwrap().into(),
            event_count: m["eventCount"].as_u64().unwrap() as u32,
            open: m["open"].as_bool().unwrap(),
            resolved: m["resolved"].as_bool().unwrap(),
            closes_at: m["closesAt"].as_i64().unwrap(),
            snapshot_block_hash: m["snapshotBlockHash"].as_str().unwrap().into(),
        };
        let config = StrategyConfig {
            quantity_atoms: i(&cfg["quantityAtoms"]),
            slippage_bps: i(&cfg["slippageBps"]),
            min_edge_bps: i(&cfg["minEdgeBps"]),
            min_edge_atoms: i(&cfg["minEdgeAtoms"]),
            max_cost_atoms: i(&cfg["maxCostAtoms"]),
            min_evidence: cfg["minEvidence"].as_u64().unwrap() as u32,
            include_singles: cfg["includeSingles"].as_bool().unwrap(),
        };
        let events: Vec<u32> = serde_json::from_value(fc["events"].clone()).unwrap();
        let listed = candidate_claims(&market.pool, market.event_count, &events, config.include_singles);
        let expected: Vec<(u32, u32)> = c["candidates"].as_array().unwrap().iter().map(|q| (q["scope"].as_u64().unwrap() as u32, i(&q["mask"]) as u32)).collect();
        assert_eq!(listed, expected, "{}", c["name"]);
        let quotes: HashMap<String, Quote> = c["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|q| !q["amountAtoms"].is_null())
            .map(|q| {
                let key = claim_key(10143, &market.pool, q["scope"].as_u64().unwrap() as u32, i(&q["mask"]) as u32);
                (key, Quote { amount_atoms: i(&q["amountAtoms"]), expires_at: q["expiresAt"].as_i64().unwrap(), block_hash: market.snapshot_block_hash.clone() })
            })
            .collect();
        let forecast = JointForecast { events, states_ppm: fc["statesPpm"].as_array().unwrap().iter().map(i).collect(), fresh_evidence: fc["freshEvidence"].as_u64().unwrap() as u32 };
        let d = decide(&market, &forecast, &config, c["now"].as_i64().unwrap(), &quotes);
        assert_eq!((json!(d.outcome), json!(d.reasons)), (x["outcome"].clone(), x["reasons"].clone()), "{}", c["name"]);
        assert_eq!(d.proposal.as_ref().map(|p| json!({"scope": p.scope, "mask": p.mask.to_string()})).unwrap_or(Value::Null), x["claim"], "{}", c["name"]);
        if let Some(p) = &d.proposal {
            let got = json!([p.quote_atoms.to_string(), p.worst_cost_atoms.to_string(), p.expected_payout_atoms.to_string(), p.edge_atoms.to_string(), p.edge_bps as i64]);
            assert_eq!(got, json!([x["quoteAtoms"], x["worstCostAtoms"], x["expectedPayoutAtoms"], x["edgeAtoms"], x["edgeBps"]]), "{}", c["name"]);
        }
        let got: Vec<Value> = d.evaluations.iter().map(|e| json!([e.scope, e.mask.to_string(), e.status, e.edge_atoms.map(|a| a.to_string())])).collect();
        let want: Vec<Value> = x["evaluations"].as_array().unwrap().iter().map(|e| json!([e["scope"], e["mask"], e["status"], e["edgeAtoms"]])).collect();
        assert_eq!(got, want, "{}", c["name"]);
    }
}

#[test]
fn signing_matches_byte_for_byte() {
    let f = fixture("calldata");
    for s in f["signing"].as_array().unwrap() {
        let signer = LocalKeySigner::new(s["privateKey"].as_str().unwrap()).unwrap();
        let t = &s["transaction"];
        let tx = Tx1559 {
            chain_id: t["chainId"].as_u64().unwrap(),
            nonce: t["nonce"].as_u64().unwrap(),
            to: t["to"].as_str().unwrap().into(),
            data: t["data"].as_str().unwrap().into(),
            value: 0,
            gas: i(&t["gas"]) as u128,
            max_fee_per_gas: i(&t["maxFeePerGas"]) as u128,
            max_priority_fee_per_gas: i(&t["maxPriorityFeePerGas"]) as u128,
        };
        assert_eq!(to_hex(&unsigned_serialized(&tx).unwrap()), s["unsignedSerialized"].as_str().unwrap(), "{}", s["note"]);
        let raw = signer.sign_transaction(&tx).unwrap();
        assert_eq!(raw, s["raw"].as_str().unwrap(), "{}", s["note"]);
        assert_eq!(transaction_hash(&raw).unwrap(), s["hash"].as_str().unwrap());
        assert_eq!(signer.address(), s["address"].as_str().unwrap());
        assert!(!format!("{:?}", signer).contains(&s["privateKey"].as_str().unwrap()[2..]));
    }
    for m in f["messages"].as_array().unwrap() {
        let signer = LocalKeySigner::new(m["privateKey"].as_str().unwrap()).unwrap();
        assert_eq!(signer.sign_message(m["message"].as_str().unwrap()).unwrap(), m["signature"].as_str().unwrap());
    }
}
