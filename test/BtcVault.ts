import crypto from 'crypto'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { BigNumber, Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'
import { time } from '@nomicfoundation/hardhat-network-helpers'

describe('BtcVault', () => {
    let initiator: SignerWithAddress
    let signatory1: SignerWithAddress
    let signatory2: SignerWithAddress
    let authorized: SignerWithAddress
    let attacker: SignerWithAddress
    let btcVault: Contract
    const vaultId = 0

    beforeEach(async () => {
        ;[initiator, signatory1, signatory2, authorized, attacker] = await ethers.getSigners()

        const BtcVault = await ethers.getContractFactory('BtcVault')
        btcVault = await BtcVault.deploy()
    })

    it('Initialize vault should work', async () => {
        const size = 220
        const name = "Satoshi's Vault"
        const threshold = 30
        const signatories = Array.from({ length: size }, () => ethers.Wallet.createRandom().address)
        const shares = Array.from({ length: size }, () => Math.floor(Math.random() * 100))
        const authorizedAddrList = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().address)
        const now = await time.latest()
        const tsList = [
            [BigNumber.from(now).add(time.duration.days(1)), 20],
            [BigNumber.from(now).add(time.duration.days(2)), 10],
            [BigNumber.from(now).add(time.duration.days(3)), 5],
        ]
        expect(await btcVault.initializeVault(name, threshold, signatories, shares, authorizedAddrList, tsList))
            .to.emit(btcVault, 'Initialized')
            .withArgs([name, initiator.address, 1, threshold, '0x00'])

        const vault = await btcVault.vaults(vaultId)
        expect(vault.name).to.eq(name)
        expect(vault.initiator).to.eq(initiator.address)
        expect(vault.threshold).to.eq(threshold)
        expect(vault.status).to.eq('0x00')
        expect(await btcVault.getVaultLength()).to.eq(1)
        const [vaultSignatories, vaultShares, vaultPubkeys] = await btcVault.getSignatories(vaultId)
        expect(signatories.length).to.eq(vaultSignatories.length)
        expect(shares.length).to.eq(vaultShares.length)
        expect(shares.length).to.eq(vaultPubkeys.length)
        for (let i = 0; i < shares.length; i++) {
            expect(signatories[i]).to.eq(vaultSignatories[i])
            expect(shares[i]).to.eq(vaultShares[i])
        }
    })

    it('Initialize vault with mismatch data should revert', async () => {
        const name = "Satoshi's Vault"
        const threshold = 30
        const signatories = Array.from({ length: 2 }, () => ethers.Wallet.createRandom().address)
        const shares = Array.from({ length: 20 }, () => Math.floor(Math.random() * 100))
        const authorizedAddrList: any[] = []
        const tsList: any[] = []
        await expect(
            btcVault.initializeVault(name, threshold, signatories, shares, authorizedAddrList, tsList)
        ).revertedWith('Mismatch signatories and shares')
    })

    describe('Approve signatory', () => {
        beforeEach(async () => {
            const name = "Satoshi's Vault"
            const threshold = 30
            const signatories = [signatory1.address, signatory2.address]
            const shares = [3000, 7000]
            const authorizedAddrList: any[] = []
            const tsList: any[] = []
            await btcVault.initializeVault(name, threshold, signatories, shares, authorizedAddrList, tsList)
        })

        it('Approve by signatory should work', async () => {
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey))
                .to.emit(btcVault, 'Accepted')
                .withArgs([vaultId, signatory1.address, btcPubkey])
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey))
                .to.emit(btcVault, 'Accepted')
                .withArgs([vaultId, signatory2.address, btcPubkey])
        })

        it('Approve with zero hash should revert', async () => {
            const btcPubkey = ethers.constants.HashZero
            await expect(btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).revertedWith(
                'Invalid btcPubkey'
            )
        })

        it('Approve by attacker should revert', async () => {
            const btcPubkey = ethers.utils.randomBytes(32)
            await expect(btcVault.connect(attacker).approveSignatory(vaultId, btcPubkey)).revertedWith(
                'Invalid signatory'
            )
        })

        it('Approve in FINAL mode should revert', async () => {
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
            expect(await btcVault.finalizeVault(vaultId)).to.emit(btcVault, 'Finalized')
            await expect(btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).revertedWith(
                'Only available in DRAFT mode'
            )
        })
    })

    describe('Finalize vault', () => {
        beforeEach(async () => {
            const name = "Satoshi's Vault"
            const threshold = 30
            const signatories = [signatory1.address, signatory2.address]
            const shares = [3000, 7000]
            const authorizedAddrList: any[] = []
            const tsList: any[] = []
            await btcVault.initializeVault(name, threshold, signatories, shares, authorizedAddrList, tsList)

            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
        })

        it('Finalize vault by initiator should work', async () => {
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
            expect(await btcVault.finalizeVault(vaultId))
                .to.emit(btcVault, 'Finalized')
                .withArgs([vaultId])
        })

        it('Finalize vault by attacker should revert', async () => {
            await expect(btcVault.connect(signatory1).finalizeVault(vaultId)).revertedWith('Invalid initiator')
            await expect(btcVault.connect(signatory2).finalizeVault(vaultId)).revertedWith('Invalid initiator')
            await expect(btcVault.connect(attacker).finalizeVault(vaultId)).revertedWith('Invalid initiator')
        })

        it('Finalize vault in FINAL mode should revert', async () => {
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
            expect(await btcVault.finalizeVault(vaultId)).to.emit(btcVault, 'Finalized')
            await expect(btcVault.finalizeVault(vaultId)).revertedWith('Only available in DRAFT mode')
        })

        it('Finalize vault with mismatch data should revert', async () => {
            await expect(btcVault.finalizeVault(vaultId)).revertedWith('Mismatch shares and pubkeys')
        })
    })

    describe('Withdraw request', () => {
        let authorizedAddrList: any[]

        beforeEach(async () => {
            const name = "Satoshi's Vault"
            const threshold = 30
            const signatories = [signatory1.address, signatory2.address]
            const shares = [3000, 7000]
            const tsList: any[] = []
            await btcVault.initializeVault(name, threshold, signatories, shares, [], tsList)

            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )

            authorizedAddrList = Array.from({ length: 10 }, () => ethers.Wallet.createRandom().address)
        })

        it('Add authorized addresses by initiator should work', async () => {
            await btcVault.addAuthorizedAddresses(vaultId, authorizedAddrList)
            const actualAddrList = await btcVault.getAuthorizedAddresses(vaultId)
            for (let i = 0; i < authorizedAddrList.length; i++) {
                expect(authorizedAddrList[i]).to.eq(actualAddrList[i])
            }
        })

        it('Add authorized addresses by attacker should revert', async () => {
            await expect(btcVault.connect(attacker).addAuthorizedAddresses(vaultId, authorizedAddrList)).revertedWith(
                'Invalid initiator'
            )
        })

        describe('Initialize withdrawal', () => {
            let scriptPubkey
            let amount
            let fee
            let request: any
            const proposalId = 0

            beforeEach(async () => {
                scriptPubkey = `0x${crypto.randomBytes(35).toString('hex')}`
                amount = 10000
                fee = 200
                request = [scriptPubkey, amount, fee]
                await btcVault.addAuthorizedAddresses(vaultId, [authorized.address])
            })

            it('Initialize withdrawal by authorized address should work', async () => {
                expect(await btcVault.connect(authorized).initiateWithdrawal(vaultId, request))
                    .to.emit(btcVault, 'WithdrawalInitiated')
                    .withArgs(vaultId, proposalId, authorized.address)
                const actualRequest = await btcVault.getWithdrawRequest(vaultId, proposalId)
                expect(actualRequest.scriptPubkey).to.eq(request[0])
                expect(actualRequest.amount).to.eq(request[1])
                expect(actualRequest.fee).to.eq(request[2])
                expect(await btcVault.nextProposalId(vaultId)).to.eq(1)
            })

            it('Initialize withdrawal by signatory should work', async () => {
                expect(await btcVault.connect(signatory1).initiateWithdrawal(vaultId, request))
                    .to.emit(btcVault, 'WithdrawalInitiated')
                    .withArgs(vaultId, proposalId, signatory1.address)
                const actualRequest = await btcVault.getWithdrawRequest(vaultId, proposalId)
                expect(actualRequest.scriptPubkey).to.eq(request[0])
                expect(actualRequest.amount).to.eq(request[1])
                expect(actualRequest.fee).to.eq(request[2])
                expect(await btcVault.nextProposalId(vaultId)).to.eq(1)
            })

            it('Initialize withdrawal by attacker should revert', async () => {
                await expect(btcVault.connect(attacker).initiateWithdrawal(vaultId, request)).revertedWith(
                    'Invalid authorized address'
                )
            })
        })

        describe('Approve withdrawal', () => {
            let scriptPubkey
            let amount
            let fee
            let request: any
            let sigList: any[]
            const proposalId = 0

            beforeEach(async () => {
                scriptPubkey = `0x${crypto.randomBytes(35).toString('hex')}`
                amount = 10000
                fee = 200
                request = [scriptPubkey, amount, fee]
                await btcVault.connect(signatory1).initiateWithdrawal(vaultId, request)

                sigList = Array.from({ length: 100 }, () => `0x${crypto.randomBytes(64).toString('hex')}`)
            })

            it('Approve withdrawal by signatory should work', async () => {
                expect(await btcVault.connect(signatory1).approveWithdrawal(vaultId, proposalId, sigList))
                    .to.emit(btcVault, 'WithdrawalApproved')
                    .withArgs(vaultId, proposalId, signatory1.address)
                const actualSigList = await btcVault.getWithdrawRequestSigs(vaultId, proposalId, signatory1.address)
                for (let i = 0; i < actualSigList.length; i++) {
                    expect(sigList[i]).to.eq(actualSigList[i])
                }
            })

            it('Initialize withdrawal by attacker should revert', async () => {
                await expect(btcVault.connect(attacker).approveWithdrawal(vaultId, proposalId, sigList)).revertedWith(
                    'Invalid signatory'
                )
            })
        })
    })
})
