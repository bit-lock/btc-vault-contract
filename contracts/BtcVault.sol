// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.0;

import '@openzeppelin/contracts/utils/structs/EnumerableMap.sol';
import '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';

contract BtcVault {
    using EnumerableMap for EnumerableMap.Bytes32ToBytes32Map;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using EnumerableSet for EnumerableSet.UintSet;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeMath for uint256;

    uint256 private constant SHARE_DENOMINATOR = 1e4;

    bytes1 private constant DRAFT = 0x00;
    bytes1 private constant FINAL = 0x01;

    bytes1 private constant PENDING = 0x00;
    bytes1 private constant ACCEPTED = 0x01;

    struct Vault {
        string name;
        address initiator;
        uint16 threshold;
        bytes1 status;
        uint16 totalShare;
    }

    struct TimelockThreshold {
        // The timestamp at which the threshold took effect
        uint32 timelock;
        uint16 threshold;
    }

    struct WithdrawRequest {
        bytes scriptPubkey;
        uint64 amount;
        uint32 fee;
    }

    /* ========== STATE VARIABLES ========== */

    Vault[] public vaults;
    TimelockThreshold[] public timelockThresholds;
    // vaultId => proposalId
    mapping(uint256 => uint256) public nextProposalId;
    // vaultId => signatory => BTC public key
    mapping(uint256 => EnumerableMap.Bytes32ToBytes32Map) private signatoryPubkeys;
    // vaultId => signatory => share
    mapping(uint256 => EnumerableMap.AddressToUintMap) private signatoryShares;
    // vaultId => authorized address
    mapping(uint256 => EnumerableSet.AddressSet) private authorizedAddresses;
    // signatory => vaultId set
    mapping(address => EnumerableSet.UintSet) private signatoryVaults;
    // vaultId => proposalId => withdraw request
    mapping(uint256 => mapping(uint256 => WithdrawRequest)) private withdrawRequests;
    // vaultId => proposalId => signatory => Schnorr signatures
    mapping(uint256 => mapping(uint256 => mapping(address => bytes[]))) private withdrawRequestSigs;

    /* ========== EVENTS ========== */

    event Initialized(uint256 indexed vaultId, Vault vault);
    event Added(uint256 indexed vaultId, address signatory, uint16 share);
    event Edited(uint256 indexed vaultId, address signatory, uint16 oldShare, uint16 newShare);
    event Accepted(uint256 indexed vaultId, address signatory, bytes32 btcPubkey);
    event Finalized(uint256 indexed vaultId);
    event WithdrawalInitiated(uint256 indexed vaultId, uint256 proposalId, address authorizedOrSignatory);
    event WithdrawalApproved(uint256 indexed vaultId, uint256 proposalId, address signatory);

    /* ========== MUTATIVE FUNCTIONS ========== */

    function initializeVault(
        string memory name,
        uint16 threshold,
        address[] memory signatories,
        uint16[] memory shares,
        address[] memory authorizedAddrList,
        TimelockThreshold[] memory tsList
    ) external {
        require(signatories.length == shares.length, 'Mismatch signatories and shares');
        require(threshold <= SHARE_DENOMINATOR, 'Threshold out of range');
        require(tsList.length <= 3, 'Only supports up to 3 timelocks');

        uint256 vaultId = vaults.length;
        Vault memory vault;

        for (uint256 i = 0; i < signatories.length; i++) {
            _addSignatory(vaultId, signatories[i], shares[i]);
            vault.totalShare = vault.totalShare + shares[i];
        }

        if (tsList.length >= 1) {
            require(tsList[0].threshold < threshold, 'Invalid threshold');
            require(tsList[0].timelock > block.timestamp, 'Invalid timelock');
        }
        if (tsList.length > 1) {
            for (uint256 i = 1; i < tsList.length; i++) {
                require(tsList[i - 1].threshold > tsList[i].threshold, 'Invalid threshold');
                require(tsList[i - 1].timelock < tsList[i].timelock, 'Invalid timelock');
            }
        }
        for (uint256 i = 0; i < tsList.length; i++) {
            timelockThresholds.push(tsList[i]);
        }

        for (uint256 i = 0; i < authorizedAddrList.length; i++) {
            authorizedAddresses[vaultId].add(authorizedAddrList[i]);
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
        uint16[] memory shares
    ) public onlyInitiator(vaultId) isDraft(vaultId) {
        uint16 _totalShare = vaults[vaultId].totalShare;
        for (uint256 i = 0; i < signatories.length; i++) {
            require(signatoryShares[vaultId].contains(signatories[i]), 'Non-existent signatory');
            uint16 oldShare = uint16(signatoryShares[vaultId].get(signatories[i]));
            uint16 newShare = shares[i];
            _totalShare = _totalShare - oldShare + newShare;

            emit Edited(vaultId, signatories[i], oldShare, newShare);
        }
        vaults[vaultId].totalShare = _totalShare;
    }

    function addAuthorizedAddresses(uint256 vaultId, address[] memory authorizedAddrList)
        external
        onlyInitiator(vaultId)
    {
        for (uint256 i = 0; i < authorizedAddrList.length; i++) {
            authorizedAddresses[vaultId].add(authorizedAddrList[i]);
        }
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

    function initiateWithdrawal(uint256 vaultId, WithdrawRequest memory request) external onlyAuthorized(vaultId) {
        require(request.scriptPubkey.length == 35, 'Invalid scriptPubkey');

        uint256 proposalId = nextProposalId[vaultId];
        withdrawRequests[vaultId][proposalId] = request;
        nextProposalId[vaultId]++;

        emit WithdrawalInitiated(vaultId, proposalId, msg.sender);
    }

    function approveWithdrawal(
        uint256 vaultId,
        uint256 proposalId,
        bytes[] memory sigs
    ) external onlySignatory(vaultId) {
        require(proposalId < nextProposalId[vaultId], 'Invalid proposalId');
        require(withdrawRequestSigs[vaultId][proposalId][msg.sender].length == 0, 'Already approved');

        for (uint256 i = 0; i < sigs.length; i++) {
            require(sigs[i].length == 65, 'Invalid sig');
            withdrawRequestSigs[vaultId][proposalId][msg.sender].push(sigs[i]);
        }

        emit WithdrawalApproved(vaultId, proposalId, msg.sender);
    }

    function _addSignatory(
        uint256 vaultId,
        address signatory,
        uint16 share
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
            uint16[] memory,
            bytes32[] memory
        )
    {
        uint256 signatorySize = signatoryShares[vaultId].length();
        address[] memory signatories = new address[](signatorySize);
        uint16[] memory shares = new uint16[](signatorySize);
        bytes32[] memory btcPubkeys = new bytes32[](signatorySize);

        for (uint256 i = 0; i < signatorySize; i++) {
            (address signatory, uint256 share) = signatoryShares[vaultId].at(i);
            signatories[i] = signatory;
            shares[i] = uint16(share);
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

    function getAuthorizedAddresses(uint256 vaultId) external view returns (address[] memory) {
        return authorizedAddresses[vaultId].values();
    }

    function getWithdrawRequest(uint256 vaultId, uint256 proposalId) external view returns (WithdrawRequest memory) {
        return withdrawRequests[vaultId][proposalId];
    }

    function getWithdrawRequestSigs(
        uint256 vaultId,
        uint256 proposalId,
        address signatory
    ) external view returns (bytes[] memory) {
        return withdrawRequestSigs[vaultId][proposalId][signatory];
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

    modifier onlyAuthorized(uint256 vaultId) {
        require(
            authorizedAddresses[vaultId].contains(msg.sender) || signatoryShares[vaultId].contains(msg.sender),
            'Invalid authorized address'
        );
        _;
    }

    modifier isDraft(uint256 vaultId) {
        require(vaults[vaultId].status == DRAFT, 'Only available in DRAFT mode');
        _;
    }
}
