// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Decimals
 * @notice Converts a fixed-point amount between two decimal scales.
 * @custom:security-contact securityreport@firelight.finance
 */
library Decimals {
    /// @notice Rescales `amount` from `fromDecimals` to `toDecimals`.
    /// @dev Scaling up is exact (rounding is irrelevant); scaling down applies `rounding`.
    /// @param amount Amount expressed with `fromDecimals` decimals.
    /// @param fromDecimals Decimals the amount is currently expressed in.
    /// @param toDecimals Target decimals.
    /// @param rounding Rounding direction used when scaling down.
    /// @return The amount expressed with `toDecimals` decimals.
    function convert(
        uint256 amount,
        uint8 fromDecimals,
        uint8 toDecimals,
        Math.Rounding rounding
    ) internal pure returns (uint256) {
        if (fromDecimals == toDecimals) return amount;
        if (fromDecimals < toDecimals) {
            return amount * 10 ** (toDecimals - fromDecimals);
        }
        return Math.mulDiv(amount, 1, 10 ** (fromDecimals - toDecimals), rounding);
    }
}
