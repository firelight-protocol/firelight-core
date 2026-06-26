// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/**
 * @notice Test-only mock of `IFlareContractRegistry`. Resolves only the
 *         `"FtsoV2"` name; everything else returns `address(0)`. Designed
 *         to be deployed once, then have its runtime bytecode copied via
 *         `hardhat_setCode` to the canonical registry address.
 */
contract MockFlareRegistry {
    address public ftsoV2;

    function setFtsoV2(address newFtso) external {
        ftsoV2 = newFtso;
    }

    function getContractAddressByName(string calldata _name) external view returns (address) {
        if (keccak256(bytes(_name)) == keccak256(bytes("FtsoV2"))) {
            return ftsoV2;
        }
        return address(0);
    }
}
