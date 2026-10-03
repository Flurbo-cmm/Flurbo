// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {TestAusdFaucet} from "../src/TestAusdFaucet.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
interface FaucetTestVm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function prank(address) external;
    function expectRevert(bytes4) external;
}
contract TestAusdFaucetTest {
    FaucetTestVm constant vm = FaucetTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    TestAusdFaucet faucet;
    MockCollateral token;
    address constant user = address(0x1234);
    function setUp() public {
        vm.chainId(10143); vm.warp(1800000000);
        faucet = new TestAusdFaucet(address(this));
        MockCollateral implementation = new MockCollateral(6);
        vm.etch(faucet.TOKEN(), address(implementation).code);
        token = MockCollateral(faucet.TOKEN()); token.mint(address(faucet), 100e6);
    }
    function testClaimCooldownAndRefill() public {
        vm.prank(user); faucet.requestFunds(user);
        assert(token.balanceOf(user) == 50e6);
        vm.expectRevert(TestAusdFaucet.TooSoon.selector); vm.prank(user); faucet.requestFunds(user);
        vm.warp(block.timestamp + 1 days); vm.prank(user); faucet.requestFunds(user);
        assert(token.balanceOf(user) == 100e6);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(TestAusdFaucet.InsufficientFunds.selector); vm.prank(user); faucet.requestFunds(user);
        token.mint(address(faucet), 50e6); vm.prank(user); faucet.requestFunds(user);
        assert(token.balanceOf(user) == 150e6);
    }
    function testCannotBurnAnotherUsersClaimOrWithdraw() public {
        vm.expectRevert(TestAusdFaucet.WrongRecipient.selector); faucet.requestFunds(user);
        assert(faucet.nextClaimAt(user) == 0);
        vm.expectRevert(TestAusdFaucet.OwnerOnly.selector); vm.prank(user); faucet.withdraw(50e6);
        faucet.withdraw(100e6); assert(token.balanceOf(address(this)) == 100e6);
    }
}
