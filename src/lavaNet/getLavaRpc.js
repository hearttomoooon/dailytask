const ethers = require('ethers');
const crypto = require('crypto');
const { Web3 } = require('web3');
const fs = require('fs');
const csvParser = require('csv-parser');
const { sleep, sendRequest } = require('../../utils/utils.js');
const fakeUa = require('fake-useragent');
const readlineSync = require('readline-sync');
const config = require('../../config/runner.json');
const axios = require('axios');
const userAgent = fakeUa();
const { HttpsProxyAgent } = require('https-proxy-agent');
const agent = new HttpsProxyAgent(config.proxy);
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// 这里定义了邀请码，请自行更换成自己的邀请码
const inviteCode = 'WQ4MC';
const provider = new Web3.providers.HttpProvider(config.ethrpc);
const web3 = new Web3(provider);

const headers = {
    'authority': 'points-api.lavanet.xyz',
    'accept': 'application/json',
    'content-type': 'application/json',
    'origin': 'https://points.lavanet.xyz',
    'referer': 'https://points.lavanet.xyz/',
    'sec-ch-ua-platform': '"Windows"',
    'user-agent': userAgent,
    'x-lang': 'english',
};


function getKeyFromUser() {
    let key;
    if (process.env.SCRIPT_PASSWORD) {
        key = process.env.SCRIPT_PASSWORD;
    } else {
        key = readlineSync.question('请输入你的密码: ', {
            hideEchoBack: true,
        });
    }
    return crypto.createHash('sha256').update(String(key)).digest('base64').substr(0, 32);
}

function decrypt(text, secretKey) {
    let parts = text.split(':');
    let iv = Buffer.from(parts.shift(), 'hex');
    let encryptedText = Buffer.from(parts.join(':'), 'hex');
    let decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(secretKey), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

async function retryRequest(url, data, urlConfig) {
    while (true) { // 使用死循环，直到请求成功
        try {
            return await axios.post(url, data, urlConfig);
        } catch (error) {
            console.log(`请求遇到错误，等待5秒后重试...`);
            await sleep(5); // 出错时等待5秒后重试
        }
    }
}


async function login(wallet) {
    const url = 'https://points-api.lavanet.xyz/accounts/metamask/login/';
    const data = {
        account: wallet.address,
        invite_code: inviteCode,
        process: 'token',
    };
    const urlConfig = {
        headers: headers,
        httpsAgent: agent,
        httpAgent: agent,
        withCredentials: true
    };

    const response = await axios.post(url, data, urlConfig);
    if (response.headers && response.headers['set-cookie']) {
        headers['cookie'] = response.headers['set-cookie'].map(cookie => {
            return cookie.split(';')[0];
        }).join('; ');
    } else {
        console.warn('响应中没有找到 set-cookie 头。');
    }

    return response.data.data;
}
async function stringToHex (str) {
    let hexString = '';
    for (let i = 0; i < str.length; i++) {
      const hexVal = str.charCodeAt(i).toString(16); // 将字符转换为ASCII码，再转换为十六进制
      hexString += hexVal;
    }

    return `0x${hexString}`;
}

async function signLoginData(hexString, wallet) {
    const url = 'https://points-api.lavanet.xyz/accounts/metamask/login/';
    const signature = await web3.eth.accounts.sign(hexString, wallet.privateKey);

    const data = {
        account: wallet.address,
        login_token: signature.signature,
        invite_code: inviteCode,
        process: 'verify',
    };
    
    const urlConfig = {
        headers: headers,
        httpsAgent: agent,
    };
    const response = await retryRequest(url, data, urlConfig);
    if (response.headers && response.headers['set-cookie']) {
        headers['cookie'] = response.headers['set-cookie'].map(cookie => {
            return cookie.split(';')[0];
        }).join('; ');
    } else {
        console.warn('响应中没有找到 set-cookie 头。');
    }
    return response.data;
    
}

async function getRpc(wallet) {
    const url = 'https://points-api.lavanet.xyz/api/v1/users/me';
    const urlConfig = {
        headers: headers,
        httpsAgent: agent,
        httpAgent: agent,
        method: 'get',
    };

    while (true) {
        try {
            const response = await sendRequest(url, urlConfig);
            return response.chains || [];
        } catch (error) {
            if (error.response && error.response.status === 502) {
                console.error(`请求失败: 服务器错误 ${error.response.status}`);
                console.error(`正在尝试重新发送请求...`);
            } else {
                // 如果不是502错误，则抛出原始错误
                throw error;
            }
        }
        // 等待5秒后重试
        await sleep(5); 
    }
}

async function saveToCsv(filePath, data) {
    // 动态确定链名称作为列标题
    const allChains = new Set();
    Object.values(data).forEach(chains => Object.keys(chains).forEach(chain => allChains.add(chain)));
    const headers = [{id: 'Address', title: 'Address'}, ...Array.from(allChains).map(chain => ({id: chain, title: chain}))]; // 构建列标题，包含Address

    // 构建CSV记录
    const records = Object.entries(data).map(([address, chains]) => {
        const record = { Address: address };
        allChains.forEach(chain => {
            record[chain] = chains[chain] || ''; // 如果某链没有URL，则留空
        });
        return record;
    });

    // 创建和写入CSV文件
    const csvWriter = createCsvWriter({
        path: filePath,
        header: headers,
    });

    await csvWriter.writeRecords(records);
    console.log('RPC数据已保存到文件');
}


async function main() {
    const secretKey = getKeyFromUser();
    const wallets = [];
    const csvPath = 'rpcData.csv'; // CSV文件路径
    let data = {};
    try {
        const csvData = fs.readFileSync(csvPath, 'utf8');
    } catch (error) {
        console.log('未找到现有rpcData文件，将创建新文件');
    }

    fs.createReadStream(config.walletPath)
    .pipe(csvParser())
    .on('data', (row) => {
        const decryptedPrivateKey = decrypt(row.privateKey, secretKey);
        wallets.push({ ...row, decryptedPrivateKey });
    })
    .on('end', async () => {
        console.log('所有地址已读取完毕, 开始获取RPC');
        for (const walletInfo of wallets) {
            const wallet = new ethers.Wallet(walletInfo.decryptedPrivateKey);
            console.log(`开始为 ${wallet.address} 获取RPC`);
            const loginStatus = await login(wallet);
            const hexString = await stringToHex(loginStatus);
            const loginData = await signLoginData(hexString, wallet);
            const chains = await getRpc(wallet);
            chains.forEach(chain => {
                chain.urls.forEach(url => {
                    if (url.name.toLowerCase().includes('mainnet')) {
                        if (!data[wallet.address]) {
                            data[wallet.address] = {};
                        }
                        data[wallet.address][chain.name] = url.value;
                    }
                });
            });
            await saveToCsv(csvPath, data);
        }
        console.log('所有地址的RPC信息已获取完毕并保存');
    }
    );
}


main();
