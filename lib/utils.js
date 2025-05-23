const { exec } = require('child_process')
const path = require('path')

const execPromise = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err)
        reject(stderr)
      resolve(stdout)
    })
  })
}

const fromHex = (data) => {
  data = data.replace(/^(0x\.)/, '')
  return data
    .split(/(\w\w)/g)
    .filter(p => !!p)
    .map(c => String.fromCharCode(parseInt(c, 16)))
    .join('')
}

const getPath = (relative_path) => {
  return path.resolve(relative_path)
}

const sleep = async (ms) => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

const toHex = (data) => {
  let result = ''
  for (let i = 0; i < data.length; i++)
    result += data.charCodeAt(i).toString(16)
  return '0x' + result.padEnd(64, '0')
}

module.exports = {
  execPromise,
  fromHex,
  getPath,
  sleep,
  toHex
}