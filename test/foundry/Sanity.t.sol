// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

// Pull an in-scope contract into the Foundry build graph so this sanity test fails
// loudly if remappings or the compiler profile regress.
import {VaultRewardDistributor} from "contracts/core/VaultRewardDistributor.sol";

/// @notice Placeholder that proves the Foundry toolchain (forge-std + remappings +
/// 0.8.28/viaIR profile) is wired correctly. Real fuzz/invariant suites land in Phase 3.
contract SanityTest is Test {
    function test_toolchainIsWired() public pure {
        assertEq(type(uint256).max, 2 ** 256 - 1);
        // In-scope contract has deployable bytecode under the configured profile.
        assertGt(type(VaultRewardDistributor).creationCode.length, 0);
    }
}
