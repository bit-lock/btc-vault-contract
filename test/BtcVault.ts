import { ethers } from 'hardhat'
import { expect } from 'chai'
import { Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers'

describe('BtcVault', () => {
    let initiator: SignerWithAddress
    let signatory1: SignerWithAddress
    let signatory2: SignerWithAddress
    let attacker: SignerWithAddress
    let btcVault: Contract

    beforeEach(async () => {
        ;[initiator, signatory1, signatory2, attacker] = await ethers.getSigners()

        const BtcVault = await ethers.getContractFactory('BtcVault')
        btcVault = await BtcVault.deploy()
    })

    it('Initialize vault should work', async () => {
        const size = 220
        const name = "Satoshi's Vault"
        const threshold = 30
        const signatories = Array.from({ length: size }, () => ethers.Wallet.createRandom().address)
        const shares = Array.from({ length: size }, () => Math.floor(Math.random() * 100))
        expect(await btcVault.initializeVault(name, threshold, signatories, shares))
            .to.emit(btcVault, 'Initialized')
            .withArgs([name, initiator.address, 1, threshold, '0x00'])

        const vaultId = 0
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
        await expect(btcVault.initializeVault(name, threshold, signatories, shares)).revertedWith(
            'Mismatch signatories and shares'
        )
    })

    describe('Approve signatory', () => {
        beforeEach(async () => {
            const name = "Satoshi's Vault"
            const threshold = 30
            const signatories = [signatory1.address, signatory2.address]
            const shares = [3000, 7000]
            await btcVault.initializeVault(name, threshold, signatories, shares)
        })

        it('Approve by signatory should work', async () => {
            const vaultId = 0
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey))
                .to.emit(btcVault, 'Accepted')
                .withArgs([vaultId, signatory1.address, btcPubkey])
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey))
                .to.emit(btcVault, 'Accepted')
                .withArgs([vaultId, signatory2.address, btcPubkey])
        })

        it('Approve with zero hash should revert', async () => {
            const vaultId = 0
            const btcPubkey = ethers.constants.HashZero
            await expect(btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).revertedWith(
                'Invalid btcPubkey'
            )
        })

        it('Approve by attacker should revert', async () => {
            const vaultId = 0
            const btcPubkey = ethers.utils.randomBytes(32)
            await expect(btcVault.connect(attacker).approveSignatory(vaultId, btcPubkey)).revertedWith(
                'Invalid signatory'
            )
        })

        it('Approve in FINAL mode should revert', async () => {
            const vaultId = 0
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
            await btcVault.initializeVault(name, threshold, signatories, shares)

            const vaultId = 0
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory1).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
        })

        it('Finalize vault by initiator should work', async () => {
            const vaultId = 0
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
            const vaultId = 0
            await expect(btcVault.connect(signatory1).finalizeVault(vaultId)).revertedWith('Invalid initiator')
            await expect(btcVault.connect(signatory2).finalizeVault(vaultId)).revertedWith('Invalid initiator')
            await expect(btcVault.connect(attacker).finalizeVault(vaultId)).revertedWith('Invalid initiator')
        })

        it('Finalize vault in FINAL mode should revert', async () => {
            const vaultId = 0
            const btcPubkey = ethers.utils.randomBytes(32)
            expect(await btcVault.connect(signatory2).approveSignatory(vaultId, btcPubkey)).to.emit(
                btcVault,
                'Accepted'
            )
            expect(await btcVault.finalizeVault(vaultId)).to.emit(btcVault, 'Finalized')
            await expect(btcVault.finalizeVault(vaultId)).revertedWith('Only available in DRAFT mode')
        })

        it('Finalize vault with mismatch data should revert', async () => {
            const vaultId = 0
            await expect(btcVault.finalizeVault(vaultId)).revertedWith('Mismatch shares and pubkeys')
        })
    })
})
