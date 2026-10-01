// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC721EnumerableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721EnumerableUpgradeable.sol";
import {ERC721PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/extensions/ERC721PausableUpgradeable.sol";

/**
 * @title CoverNFT
 * @notice Upgradeable ERC-721 token representing covers created by the CoverOrderAllocator.
 * The CoverOrderAllocator is expected to mint one NFT per settled cover order.
 *
 * @custom:security-contact securityreport@firelight.finance
 */
contract CoverNFT is
    ERC721Upgradeable,
    ERC721EnumerableUpgradeable,
    ERC721PausableUpgradeable,
    AccessControlUpgradeable
{
    /// @notice Role allowed to pause and unpause the contract.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role allowed to mint new NFTs.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role allowed to update the collection base URI.
    bytes32 public constant URI_MANAGER_ROLE = keccak256("URI_MANAGER_ROLE");

    // --- ERC-7201 Namespaced Storage ---
    /// @custom:storage-location erc7201:firelight.covernft.storage
    struct CoverNFTStorage {
        string baseURI;
    }

    // keccak256(abi.encode(uint256(keccak256("firelight.covernft.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x426682ee43cf77999495f05d99a85f0091c30c5f2afdd681b11771286cb00b00;

    function _getStorage() private pure returns (CoverNFTStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /**
     * @notice Emitted when the base URI is updated.
     * @param oldBaseURI Previous base URI.
     * @param newBaseURI New base URI.
     */
    event BaseURIUpdated(string oldBaseURI, string newBaseURI);

    /// @notice Thrown when admin is zero address.
    error InvalidAdmin();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the CoverNFT contract.
     * @param name_ ERC-721 token name.
     * @param symbol_ ERC-721 token symbol.
     * @param baseURI_ Initial base URI for token metadata. May be empty.
     * @param admin Address granted DEFAULT_ADMIN_ROLE.
     * @param minter Address granted MINTER_ROLE.
     * @param pauser Address granted PAUSER_ROLE. May be zero address.
     * @param uriManager Address granted URI_MANAGER_ROLE. May be zero address.
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        string memory baseURI_,
        address admin,
        address minter,
        address pauser,
        address uriManager
    ) public initializer {
        __ERC721_init(name_, symbol_);
        __ERC721Enumerable_init();
        __ERC721Pausable_init();
        __AccessControl_init();

        if (admin == address(0)) revert InvalidAdmin();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);

        if (minter != address(0)) _grantRole(MINTER_ROLE, minter);
        if (pauser != address(0)) _grantRole(PAUSER_ROLE, pauser);
        if (uriManager != address(0)) _grantRole(URI_MANAGER_ROLE, uriManager);

        _setBaseURI(baseURI_);
    }

    /**
     * @notice Safely mints a new cover order NFT.
     * @param to Address receiving the NFT.
     * @param tokenId Token id to mint.
     */
    function safeMint(address to, uint256 tokenId) public onlyRole(MINTER_ROLE) {
        _safeMint(to, tokenId);
    }

    /**
     * @notice Updates the base URI used for token metadata.
     * @param baseURI_ New base URI for token metadata. May be empty.
     */
    function setBaseURI(string memory baseURI_) public onlyRole(URI_MANAGER_ROLE) {
        _setBaseURI(baseURI_);
    }

    /**
     * @notice Pauses token transfers, minting, and burning.
     */
    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses token transfers, minting, and burning.
     */
    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /**
     * @dev Stores a new base URI for token metadata.
     * @param baseURI_ New base URI for token metadata.
     */
    function _setBaseURI(string memory baseURI_) private {
        CoverNFTStorage storage $ = _getStorage();
        string memory oldBaseURI = $.baseURI;
        $.baseURI = baseURI_;
        emit BaseURIUpdated(oldBaseURI, baseURI_);
    }

    /**
     * @notice Returns the base URI used by ERC-721 metadata functions to construct token URIs.
     * @return Base URI for token metadata.
     */
    function _baseURI() internal view override returns (string memory) {
        return _getStorage().baseURI;
    }

    // --- Required overrides --- //

    /// @dev Resolves the {ERC721}, {ERC721Enumerable}, and {ERC721Pausable} `_update` hooks.
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable, ERC721PausableUpgradeable) returns (address) {
        return super._update(to, tokenId, auth);
    }

    /// @dev Resolves the {ERC721} and {ERC721Enumerable} `_increaseBalance` hooks.
    function _increaseBalance(
        address account,
        uint128 value
    ) internal override(ERC721Upgradeable, ERC721EnumerableUpgradeable) {
        super._increaseBalance(account, value);
    }

    /// @notice Returns whether the contract implements `interfaceId` (ERC-165).
    /// @dev Resolves the {ERC721}, {ERC721Enumerable}, and {AccessControl} implementations.
    /// @param interfaceId Interface identifier to query.
    /// @return True if the interface is supported.
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC721Upgradeable, ERC721EnumerableUpgradeable, AccessControlUpgradeable) returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
