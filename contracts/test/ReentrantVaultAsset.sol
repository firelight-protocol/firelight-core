// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @dev Malicious ERC20 used as a FirelightVault underlying asset. On every token
 *      movement it re-enters the vault with a configurable call, letting tests hit
 *      the `nonReentrant` revert branches of deposit/mint/claimWithdraw/payout.
 *      The inner revert is bubbled up so assertions can match the vault error.
 */
contract ReentrantVaultAsset is ERC20 {
    address public vault;
    bytes public reentrantCall;
    bool private _entered;

    constructor() ERC20("Reentrant Asset", "rASSET") {}

    function setVault(address vault_) external {
        vault = vault_;
    }

    /// @dev Empty bytes disables the attack.
    function setReentrantCall(bytes calldata data) external {
        reentrantCall = data;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);

        if (vault != address(0) && reentrantCall.length > 0 && !_entered) {
            _entered = true;
            (bool success, bytes memory returndata) = vault.call(reentrantCall);
            _entered = false;
            if (!success) {
                assembly {
                    revert(add(returndata, 0x20), mload(returndata))
                }
            }
        }
    }
}
