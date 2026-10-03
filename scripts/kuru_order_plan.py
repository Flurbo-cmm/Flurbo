"""Offline, unsigned Kuru order units. No RPC, signing, approvals or broadcasts."""

import argparse
from fractions import Fraction
import json
from pathlib import Path
import re

CONFIG = Path(__file__).resolve().parents[1] / "config/kuru-testnet-plan.json"
# Selectors checked against the pinned Router/OrderBook source using Foundry cast.
BUY = "a09e9040"  # addBuyOrder(uint32,uint96,bool)
SELL = "40e79b1b"  # addSellOrder(uint32,uint96,bool)
CANCEL = "23afbff3"  # batchCancelOrders(uint40[])


def validate(config):
    fields = ("chain_id", "market_type", "base_decimals", "quote_decimals", "size_precision",
              "price_precision", "tick_size", "size_step", "min_size", "max_size",
              "taker_fee_bps", "maker_fee_bps", "amm_spread_bps")
    if any(type(config.get(key)) is not int for key in fields):
        raise ValueError("Plan parameters must be integers")
    if (config["chain_id"], config["market_type"], config["base_decimals"], config["quote_decimals"]) != (10143, 0, 6, 6):
        raise ValueError("This draft supports only testnet ERC20/ERC20 pairs with six-decimal assets")
    for key, bits in (("size_precision", 96), ("price_precision", 32)):
        value = config[key]
        if not 0 < value < 2**bits or not re.fullmatch(r"10*", str(value)):
            raise ValueError("Precisions must be powers of ten within their ABI widths")
    tick, step = config["tick_size"], config["size_step"]
    if not 0 < tick < 2**32 or config["price_precision"] % tick:
        raise ValueError("Tick must divide the unit payout price")
    if not 0 < step <= config["min_size"] < config["max_size"] < 2**96:
        raise ValueError("Invalid size bounds or client size increment")
    if config["min_size"] % step or config["max_size"] % step:
        raise ValueError("Size bounds must align with the client increment")
    if config["size_precision"] > 10**6 or config["price_precision"] > 10**6:
        raise ValueError("Draft precisions cannot exceed collateral atomic precision")
    if tick * step % config["size_precision"]:
        raise ValueError("Tick and size increment would create rounded quote reserves")
    if not 0 <= config["maker_fee_bps"] <= config["taker_fee_bps"] < 10000:
        raise ValueError("Invalid maker rebate/taker fee relationship")
    if not 0 < config["amm_spread_bps"] < 500 or config["amm_spread_bps"] % 10:
        raise ValueError("AMM spread must be a multiple of ten from 10 through 490 bps")


def scaled(text, precision):
    if not isinstance(text, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?", text):
        raise ValueError("Use a nonnegative plain decimal string, without exponent notation")
    value = Fraction(text) * precision
    if value.denominator != 1:
        raise ValueError("Amount cannot be represented exactly at the market precision")
    return value.numerator


def word(value):
    return f"{value:064x}"


def plan_order(config, side, price, size):
    validate(config)
    if side not in ("buy", "sell"):
        raise ValueError("Side must be buy or sell")
    price_units = scaled(price, config["price_precision"])
    size_units = scaled(size, config["size_precision"])
    if not 0 < price_units <= config["price_precision"] or price_units >= 2**32 - 1:
        raise ValueError("Draft outcome price must be greater than zero and at most one AUSD")
    if price_units % config["tick_size"]:
        raise ValueError("Price is off tick; no silent rounding")
    if not config["min_size"] <= size_units <= config["max_size"] or size_units % config["size_step"]:
        raise ValueError("Size is outside bounds or off the client increment")
    product = price_units * size_units
    quote_units = (product + config["size_precision"] - 1) // config["size_precision"]
    if quote_units >= 2**96:
        raise ValueError("Order quote reserve exceeds Kuru uint96")
    base_atoms = size_units * 10**6 // config["size_precision"]
    quote_atoms = quote_units * 10**6 // config["price_precision"]
    return {"read_only": True, "side": side, "price_units": price_units, "size_units": size_units,
            "post_only": True, "base_atoms": base_atoms, "quote_atoms": quote_atoms,
            "margin_asset": "AUSD" if side == "buy" else "canonical_base_receipt",
            "required_margin_atoms": quote_atoms if side == "buy" else base_atoms,
            "order_calldata": "0x" + (BUY if side == "buy" else SELL) + word(price_units) + word(size_units) + word(1),
            "scope": "Unsigned payload only; no market address, approvals, margin deposit or execution"}


def cancel_calldata(order_id):
    if type(order_id) is not int or not 0 < order_id < 2**40:
        raise ValueError("Use an actual nonzero uint40 order ID from the confirmed placement event")
    return "0x" + CANCEL + word(32) + word(1) + word(order_id)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--side", choices=("buy", "sell"), default="buy")
    parser.add_argument("--price", default="0.50")
    parser.add_argument("--size", default="1")
    args = parser.parse_args()
    try:
        print(json.dumps(plan_order(json.loads(CONFIG.read_text()), args.side, args.price, args.size), indent=2))
    except (ValueError, KeyError) as error:
        parser.exit(1, f"Invalid draft: {error}\n")


if __name__ == "__main__":
    main()
