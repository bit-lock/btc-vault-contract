// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import '@openzeppelin/contracts/utils/structs/EnumerableMap.sol';
import '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';

contract BtcVault {
    using EnumerableMap for EnumerableMap.Bytes32ToBytes32Map;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.UintSet;
    using SafeMath for uint256;

    uint256 private constant SHARE_DENOMINATOR = 1e4;

    bytes1 private constant DRAFT = 0x00;
    bytes1 private constant FINAL = 0x01;

    bytes1 private constant PENDING = 0x00;
    bytes1 private constant ACCEPTED = 0x01;

    struct Vault {
        string name;
        address initiator;
        uint8 threshold;
        bytes1 status;
        uint256 totalShare;
    }

    /* ========== STATE VARIABLES ========== */

    Vault[] public vaults;
    // vaultId => signatory => BTC public key
    mapping(uint256 => EnumerableMap.Bytes32ToBytes32Map) private signatoryPubkeys;
    // vaultId => signatory => share
    mapping(uint256 => EnumerableMap.AddressToUintMap) private signatoryShares;
    // signatory => vaultId set
    mapping(address => EnumerableSet.UintSet) private signatoryVaults;

    /* ========== EVENTS ========== */

    event Initialized(uint256 indexed vaultId, Vault vault);
    event Added(uint256 indexed vaultId, address signatory, uint256 share);
    event Edited(uint256 indexed vaultId, address signatory, uint256 oldShare, uint256 newShare);
    event Accepted(uint256 indexed vaultId, address signatory, bytes32 btcPubkey);
    event Finalized(uint256 indexed vaultId);

    /* ========== MUTATIVE FUNCTIONS ========== */

    function initializeVault(
        string memory name,
        uint8 threshold,
        address[] memory signatories,
        uint256[] memory shares
    ) external {
        require(signatories.length == shares.length, 'Mismatch signatories and shares');
        require(threshold <= SHARE_DENOMINATOR, 'Threshold out of range');

        uint256 vaultId = vaults.length;
        Vault memory vault;

        for (uint256 i = 0; i < signatories.length; i++) {
            _addSignatory(vaultId, signatories[i], shares[i]);
            vault.totalShare = vault.totalShare.add(shares[i]);
        }

        vault.name = name;
        vault.initiator = msg.sender;
        vault.threshold = threshold;
        vault.status = DRAFT;
        vaults.push(vault);

        emit Initialized(vaultId, vault);
    }

    function editSignatories(
        uint256 vaultId,
        address[] memory signatories,
        uint256[] memory shares
    ) public onlyInitiator(vaultId) isDraft(vaultId) {
        uint256 _totalShare = vaults[vaultId].totalShare;
        for (uint256 i = 0; i < signatories.length; i++) {
            require(signatoryShares[vaultId].contains(signatories[i]), 'Non-existent signatory');
            uint256 oldShare = signatoryShares[vaultId].get(signatories[i]);
            uint256 newShare = shares[i];
            _totalShare = _totalShare.sub(oldShare).add(newShare);

            emit Edited(vaultId, signatories[i], oldShare, newShare);
        }
        vaults[vaultId].totalShare = _totalShare;
    }

    function approveSignatory(uint256 vaultId, bytes32 btcPubkey) external onlySignatory(vaultId) isDraft(vaultId) {
        require(btcPubkey != bytes32(0), 'Invalid btcPubkey');
        signatoryPubkeys[vaultId].set(bytes32(bytes20(msg.sender)), btcPubkey);

        emit Accepted(vaultId, msg.sender, btcPubkey);
    }

    function finalizeVault(uint256 vaultId) external onlyInitiator(vaultId) isDraft(vaultId) {
        require(signatoryShares[vaultId].length() == signatoryPubkeys[vaultId].length(), 'Mismatch shares and pubkeys');
        require(vaults[vaultId].totalShare == SHARE_DENOMINATOR, 'Total share value out of range');

        vaults[vaultId].status = FINAL;

        emit Finalized(vaultId);
    }

    function initiateWithdrawal() external {}

    function approveWithdrawal() external {}

    function _addSignatory(
        uint256 vaultId,
        address signatory,
        uint256 share
    ) private {
        signatoryShares[vaultId].set(signatory, share);
        signatoryVaults[signatory].add(vaultId);

        emit Added(vaultId, signatory, share);
    }

    /* ========== VIEWS ========== */

    function getVaultLength() external view returns (uint256) {
        return vaults.length;
    }

    function getSignatories(uint256 vaultId)
        external
        view
        returns (
            address[] memory,
            uint256[] memory,
            bytes32[] memory
        )
    {
        uint256 signatorySize = signatoryShares[vaultId].length();
        address[] memory signatories = new address[](signatorySize);
        uint256[] memory shares = new uint256[](signatorySize);
        bytes32[] memory btcPubkeys = new bytes32[](signatorySize);

        for (uint256 i = 0; i < signatorySize; i++) {
            (address signatory, uint256 share) = signatoryShares[vaultId].at(i);
            signatories[i] = signatory;
            shares[i] = share;
            bytes32 signatoryBytes32 = bytes32(bytes20(signatory));
            if (signatoryPubkeys[vaultId].contains(signatoryBytes32)) {
                btcPubkeys[i] = signatoryPubkeys[vaultId].get(signatoryBytes32);
            }
        }

        return (signatories, shares, btcPubkeys);
    }

    function getSignatoryVaults(address signatory) external view returns (uint256[] memory, bytes1[] memory) {
        uint256[] memory vaultIds = signatoryVaults[signatory].values();
        bytes1[] memory approveStatus = new bytes1[](vaultIds.length);
        bytes32 signatoryBytes32 = bytes32(bytes20(signatory));

        for (uint256 i = 0; i < vaultIds.length; i++) {
            uint256 vaultId = vaultIds[i];
            approveStatus[i] = signatoryPubkeys[vaultId].contains(signatoryBytes32) ? ACCEPTED : PENDING;
        }

        return (vaultIds, approveStatus);
    }

    /* ========== MODIFIERS ========== */

    modifier onlyInitiator(uint256 vaultId) {
        require(msg.sender == vaults[vaultId].initiator, 'Invalid initiator');
        _;
    }

    modifier onlySignatory(uint256 vaultId) {
        require(signatoryShares[vaultId].contains(msg.sender), 'Invalid signatory');
        _;
    }

    modifier isDraft(uint256 vaultId) {
        require(vaults[vaultId].status == DRAFT, 'Only available in DRAFT mode');
        _;
    }
}
