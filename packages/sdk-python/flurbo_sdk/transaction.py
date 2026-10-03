"""The only transactions a runtime may sign, built and then validated on the final bytes before signing:
chain, contract, token, method, amounts and beneficiary (the pool credits msg.sender, so the signer must be
the agent wallet)."""
from .abi import decode_call, encode_call
from .claims import validate_claim
from .errors import FlurboError
from .protocol import COLLATERAL, SERVICE_MAX_ATOMS


def _bad(message: str):
    raise FlurboError("invalid_input", f"Refusing to sign: {message}.")


def build_transaction(intent: dict, deployment: dict, wallet: str) -> dict:
    """intent: {action: buy|sell, claim:{scope,mask:int}, quantityAtoms, limitAtoms, deadline} | {action: redeem, claim, quantityAtoms} | {action: approve, amountAtoms}."""
    a = intent["action"]
    if a == "approve":
        to, data = COLLATERAL, encode_call("approve", [deployment["pool"], intent["amountAtoms"]])
    elif a == "redeem":
        to, data = deployment["pool"], encode_call("redeem", [intent["claim"]["scope"], intent["claim"]["mask"], intent["quantityAtoms"]])
    else:
        to, data = deployment["pool"], encode_call(a, [intent["claim"]["scope"], intent["claim"]["mask"], intent["quantityAtoms"], intent["limitAtoms"], intent["deadline"]])
    tx = {"chainId": 10143, "from": wallet.lower(), "to": to, "data": data, "value": 0}
    validate_transaction(tx, intent, deployment, wallet)
    return tx


def validate_transaction(tx: dict, intent: dict, deployment: dict, wallet: str) -> None:
    if tx["chainId"] != 10143 or deployment["chainId"] != 10143:
        _bad("not Monad testnet")
    if tx["value"] != 0:
        _bad("value must be zero")
    if tx["from"].lower() != wallet.lower():
        _bad("the signer is not the agent wallet")
    name, args = decode_call(tx["data"])
    if name != intent["action"]:
        _bad("the method differs from the intent")
    if intent["action"] == "approve":
        if tx["to"].lower() != COLLATERAL:
            _bad("approvals are only for test AUSD")
        spender, amount = args
        if "0x" + format(spender, "040x") != deployment["pool"]:
            _bad("the spender is not the pool")
        if amount != intent["amountAtoms"] or amount == 0 or amount > SERVICE_MAX_ATOMS:
            _bad("the approval amount is outside the service limit")
        return
    if tx["to"].lower() != deployment["pool"]:
        _bad("the contract is not the published pool")
    scope, mask, quantity = args[0], args[1], args[2]
    if scope != intent["claim"]["scope"] or mask != intent["claim"]["mask"] or quantity != intent["quantityAtoms"]:
        _bad("the claim or quantity differs from the intent")
    try:
        validate_claim(scope, str(mask), deployment["eventCount"])
    except FlurboError:
        _bad("the claim is not supported in this pool")
    if quantity < 1 or quantity > SERVICE_MAX_ATOMS:
        _bad("the quantity is outside the service limit")
    if intent["action"] in ("buy", "sell"):
        limit, deadline = args[3], args[4]
        if limit != intent["limitAtoms"] or limit > SERVICE_MAX_ATOMS or (intent["action"] == "buy" and limit == 0):
            _bad("the limit differs from the intent or the service limit")
        if deadline != intent["deadline"] or intent["deadline"] >= deployment["closesAt"]:
            _bad("the deadline differs from the intent or is after the close")
