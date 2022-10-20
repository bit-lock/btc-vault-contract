import { DeployFunction } from 'hardhat-deploy/types'
import { HardhatRuntimeEnvironment } from 'hardhat/types'

const deployFunction: DeployFunction = async function ({ deployments, getNamedAccounts }: HardhatRuntimeEnvironment) {
    console.log('Running BtcVault deploy script')

    const { deploy } = deployments
    const { deployer } = await getNamedAccounts()
    const { address } = await deploy('BtcVault', { from: deployer })

    console.log('BtcVault deployed at', address)
}

export default deployFunction

deployFunction.dependencies = ['']

deployFunction.tags = ['BtcVault']
