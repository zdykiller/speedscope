import {readFileSync, readdirSync, statSync, writeFileSync} from 'fs'
import {importProfileGroupFromText} from '../import'
import {CallTreeNode, Frame, Profile} from '../lib/profile'
// import {getChronoViewFlamechart} from '../views/flamechart-view-container'
import {Flamechart} from '../lib/flamechart'

/**
 * 帧信息计算工具
 */
class FrameCalcTool {
  public frameList: FrameInfo[]
  constructor() {
    this.frameList = []
  }
  /**
   * 算传入函数的时间分位数
   * @param infoKey
   * @param quantile 计算分位数配置 ，形如 [0.1, 0.5, 0.9]
   */
  calcInfo(infoKey: string, quantile: number[]) {
    let recordList = []
    for (let f of this.frameList) {
      let keyLength = f.getInfoLength(infoKey)
      recordList.push(keyLength)
    }
    let resultList = this.getQuantile(recordList, quantile)
    let frameList = this.frameList
    return {frameList, resultList}
  }

  /**
   * 排序查对应的分位数，并取结果
   */
  getQuantile(numberArray: number[], quantile: number[]) {
    let length = numberArray.length
    let x = numberArray.sort((a, b) => {
      return a - b
    })
    // let quantile = [0.25, 0.5, 0.75]
    let result = []
    for (let q of quantile) {
      let index = Math.floor(q * length)
      result.push(x[index])
    }
    return result
  }

  /**
   * 判断是否在开发者工具中调用
   * @param flameChart
   */
  isCallInDevTool(flameChart: Flamechart) {
    let layerStack = flameChart.getLayers()
    let firstLine = layerStack[0]
    let isCallInDevTool = false
    for (let i = 0; i < firstLine.length; i++) {
      let child = firstLine[i].node
      // 在开发者工具中调用，有cbWithTimeStamp函数
      isCallInDevTool = isCallFunc(child, 'cbWithTimeStamp')
      if (isCallInDevTool) {
        break
      }
    }
    return isCallInDevTool
  }
}

/**
 * Unity的帧信息记录
 */
class FrameInfo {
  /**
   *  起始时间
   */
  public startTime: number
  /**
   * 结束时间
   */
  public endTime: number
  /**
   * 下一帧的起始时间
   */
  public nextStartTime: number
  /**
   * 特殊信息表，存一些统计数据的结果
   */
  public infoDict: {[key: string]: number}

  /**
   * 获取帧执行的时长（微秒）
   */
  getExecuteLength() {
    return this.endTime - this.startTime
  }

  /**
   * 获取帧长度（微秒）
   */
  getFrameInterval() {
    return this.nextStartTime - this.startTime
  }

  getInfoLength(infoKey: string) {
    if (infoKey == 'execute') {
      return this.getExecuteLength()
    }
    if (infoKey == 'interval') {
      return this.getFrameInterval()
    }
    return this.infoDict[infoKey] || 0
  }

  constructor() {
    this.startTime = 0
    this.endTime = 0
    this.nextStartTime = 0
    this.infoDict = {}
  }
}

/**
 * 日志记录
 */
class LogData {
  /**
   * 日志记录列表，每行一条
   */
  public logList: string[]
  constructor() {
    this.logList = []
  }
  log(log: string) {
    console.log(log)
    this.logList.push(log)
  }
  error(log: string) {
    console.error(log)
    this.logList.push(log)
  }

  /**
   * 写日志
   * @param outputFilePath
   */
  writeLog(outputFilePath: string) {
    let logContent = this.logList.join('\n')
    writeFileSync(outputFilePath, logContent)
  }
}

/**
 * 读取文件并分析
 * @param fileName 文件名，注意仅文件名，是用于区分的
 * @param fileContent 文件读取的string内容
 */
async function ReadFileCalc(fileName: string, fileContent: string) {
  let logData = new LogData()

  let promise = importProfileGroupFromText(fileName, fileContent)
  await promise.then(res => {
    if (res == null) {
      logData.error(`没有成功解析文件 ${fileName}`)
      return
    }
    let targetProfile: Profile | null = null

    if (res.name.includes('.json')) {
      // timeline数据，从performance里获取到，只关注CrRendererMain
      for (let profile of res.profiles) {
        if (profile.getName().includes('CrRendererMain')) {
          targetProfile = profile
          break
        }
      }
      if (targetProfile == null) {
        logData.error(`解析有效，但缺少CrRendererMain ${fileName}`)
        return
      }
    } else if (res.name.includes('.cpuprofile')) {
      // cpuprofile数据，从javascriptprofiler录制出来的，仅有一个profile
      targetProfile = res.profiles[0]
    }
    if (targetProfile == null) {
      logData.error(`解析有效，但没有找到有效的profile ${fileName}`)
      return
    }

    let getColorBucketForFrame = function (f: Frame) {
      return 0
    }

    // 从profiler信息转成获取火焰图信息
    let flameChart = new Flamechart({
      getTotalWeight: targetProfile.getTotalWeight.bind(targetProfile),
      forEachCall: targetProfile.forEachCall.bind(targetProfile),
      formatValue: targetProfile.formatValue.bind(targetProfile),
      getColorBucketForFrame,
    })
    // layers按层记录，二维数组，内部每个数组对应火焰图的一行的所有条块，外部数组记录每行
    let layerStack = flameChart.getLayers()
    let firstLine = layerStack[0]

    // 调用Unity的时长
    let callUnityWeight = 0
    // 调用Unity的次数
    let callUnityCount = 0

    let frameInfoList: FrameInfo[] = []
    let collectDict: {[key: string]: string} = {}

    let calcTool = new FrameCalcTool()

    // 判断是否为
    let isCallInDevTool = calcTool.isCallInDevTool(flameChart)

    // 火焰图总时长，微妙
    let flameTotalWeight = flameChart.getTotalWeight()
    // 非开发者工具，即真机上调用，去掉前5s 后5s时间，减少一些干扰，前提是时长够长

    let startCut = 5 * 1000 * 1000
    let endCut = 5 * 1000 * 1000
    if (flameTotalWeight < startCut + endCut) {
      logData.log(`长度不够切分的`)
      return
    }

    let startLimit = startCut
    let endLimit = flameChart.getTotalWeight() - endCut
    if (!isCallInDevTool) {
      let tempFirstLine = []
      for (let i = 0; i < firstLine.length; i++) {
        let flameChartFrame = firstLine[i]
        if (flameChartFrame.end < startLimit) {
          // 时间是微秒，5s，早于5s的帧不要
          continue
        }
        if (flameChartFrame.start > endLimit) {
          // 时间是微秒，5s，晚于5s的帧不要
          continue
        }
        tempFirstLine.push(flameChartFrame)
      }
      // 如果去掉了无用帧，那重新算时长
      firstLine = tempFirstLine
      flameTotalWeight = firstLine[firstLine.length - 1].end - firstLine[0].start

      let log = `去掉了前 ${startCut / 1000 / 1000}秒，后 ${endCut / 1000 / 1000}秒，
        从${flameChart.getTotalWeight() / 1000 / 1000}秒 => ${flameTotalWeight / 1000 / 1000}秒`
      logData.log(log)
    }
    for (let i = 0; i < firstLine.length; i++) {
      let frameInfo = new FrameInfo()

      let child = firstLine[i].node
      if (i < firstLine.length - 1) {
        let currFlameChartFrame = firstLine[i]
        let nextFlameChartFrame = firstLine[i + 1]
        frameInfo.startTime = currFlameChartFrame.start
        frameInfo.endTime = currFlameChartFrame.end
        frameInfo.nextStartTime = nextFlameChartFrame.start
      } else {
        let currFlameChartFrame = firstLine[i]
        frameInfo.startTime = currFlameChartFrame.start
        frameInfo.endTime = currFlameChartFrame.end
        frameInfo.nextStartTime = flameChart.getTotalWeight()
      }

      // 检查此时是否回调到了Unity，用Browser_mainLoop_runner函数判断
      let isCallUnity = isCallFunc(child, 'Browser_mainLoop_runner')
      if (isCallUnity) {
        callUnityWeight += child.getTotalWeight()
        callUnityCount += 1

        let tempWeightDict: {[key: string]: number} = {}
        CheckBaseBehaviourManager(child, tempWeightDict)
        frameInfo.infoDict = tempWeightDict
        frameInfoList.push(frameInfo)
        for (let k in tempWeightDict) {
          collectDict[k] = k
        }
      }
    }

    calcTool.frameList = frameInfoList

    let keyList = Object.keys(collectDict).sort()
    keyList.push('execute')
    keyList.push('interval')
    // 按照记录key计算
    for (let k of keyList) {
      // 分位数结果
      let quantile = [0.25, 0.5, 0.75, 0.9]

      let {frameList, resultList} = calcTool.calcInfo(k, quantile)
      resultList = resultList.map(x => x / 1000)
      logData.log(`${k}`)
      logData.log(`记录次数 ${frameList.length}`)
      logData.log(`分位数配置 ${quantile.join('-')}`)
      logData.log(`分位数结果(ms) ${resultList.join('-')}`)
    }

    // 总时长（秒）
    let timeSecond = (flameTotalWeight / 1000 / 1000).toFixed(2)
    // 调用unity的时长（秒）
    let callUnitySecond = (callUnityWeight / 1000 / 1000).toFixed(2)
    // unity帧执行占总时间的比
    let ratio = (callUnityWeight / flameTotalWeight).toFixed(2)
    logData.log(`文件名 ${fileName}`)
    logData.log(`录制时长（秒）: ${timeSecond}`)
    logData.log(
      `回调Unity次 ${callUnityCount}, 回调Unity时长（秒）: ${callUnitySecond}, 回调Unity时长占录制时长比: ${ratio}`,
    )

    // let keyList = Object.keys(weightDict).sort()
    // // 帧信息
    // for (let key of keyList) {
    //   console.log(
    //     `key: ${key}, 录制时长（秒）: ${(weightDict[key] / 1000 / 1000).toFixed(2)}, 占总比: ${(
    //       weightDict[key] / totalWeight
    //     ).toFixed(2)}，占Unity比: ${(weightDict[key] / callUnityWeight).toFixed(2)}`,
    //   )
    // }
  })
  return logData
}

/**
 * 调用了查询整个调用栈是否调用了某个方法
 * @param childNode
 * @param funcName 调用的函数名
 */
function isCallFunc(childNode: CallTreeNode, funcName: string): boolean {
  if (childNode.frame.name.includes(funcName)) {
    return true
  }
  for (let child of childNode.children) {
    if (isCallFunc(child, funcName)) {
      return true
    }
  }
  return false
}

/**
 * 检查并统计其中的CommonUpdate<xxx>函数耗时
 * @param childNode 当前节点
 * @param weightDict 权重记录的字典
 */
function CheckBaseBehaviourManager(childNode: CallTreeNode, weightDict: any) {
  if (weightDict == null) {
    weightDict = {}
  }
  // CommonUpdate<xxx>有三种Update LateUpdate FixedUpdate， 另外『c++filt』工具能反向解析出函数名
  if (childNode.frame.name.includes('__ZN20BaseBehaviourManager12CommonUpdate')) {
    let key = childNode.frame.name
    if (weightDict[key] == null) {
      weightDict[key] = 0
    }
    weightDict[key] += childNode.getTotalWeight()
    return weightDict
  }

  for (let child of childNode.children) {
    CheckBaseBehaviourManager(child, weightDict)
  }
  return weightDict
}

/**
 * 文件名排序，从后往前取3个-分割的字符串，然后排序
 * 比如
 * xxxx-大号-主城-静置.json
 * xxxx-大号-冒险-静置.json
 * xxxx-小号-主城-静置.json
 * @param a
 * @param b
 */
let sortFunc = (a: string, b: string) => {
  let calcNumber = 3
  let aList = a.split('-')
  let aKey = ''
  for (let i = 1; i < calcNumber + 1; i++) {
    aKey = aList[aList.length - i] + '-' + aKey
  }
  let bKey = ''
  let bList = b.split('-')
  for (let i = 1; i < calcNumber + 1; i++) {
    bKey = bList[bList.length - i] + '-' + bKey
  }
  return aKey.toLowerCase().localeCompare(bKey.toLowerCase())
}

/**
 * 获取文件夹下的文件名，并排序
 * @param fileDir 文件夹路径
 */
function getSortFilePath(fileDir: string) {
  let filePathList = []
  // let fileDir = '/Users/admin/WorkProjects/WeChatProjects/Profiler/HybridCLR'
  let files = readdirSync(fileDir)
  files.sort(sortFunc)
  for (let fileName of files) {
    filePathList.push(fileDir + '/' + fileName)
  }
  return filePathList
}

class ProcessData {
  public summaryoutputPath: string
  public processDataFileList: string[]

  constructor(outputPath: string, processDataFileList: string[]) {
    this.summaryoutputPath = outputPath
    this.processDataFileList = processDataFileList
  }
}

/**
 * 获取开发者工具的数据
 */
function getDevToolData(): ProcessData[] {
  let dataList: ProcessData[] = []

  let hybridFiles = getSortFilePath(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/devtool_HybridCLR',
  )
  let processData = new ProcessData(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/devtool_HybridCLR/info.txt',
    hybridFiles,
  )
  dataList.push(processData)

  // 从il2cpp目录里取文件名
  let il2cppFiles = getSortFilePath(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/devtool_il2cpp',
  )
  let processData2 = new ProcessData(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/devtool_HybridCLR/info.txt',
    il2cppFiles,
  )

  dataList.push(processData2)
  return dataList
}

/**
 * 获取magicv2设备数据
 */
function getMobileMagicV2Data(): ProcessData[] {
  let dataList: ProcessData[] = []
  let magicv2HybridclrFiles = getSortFilePath(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/magicv2_Hybridclr',
  )
  let processData = new ProcessData(
    '/Users/admin/WorkProjects/WeChatProjects/Profiler/magicv2_Hybridclr/info.txt',
    magicv2HybridclrFiles,
  )
  dataList.push(processData)
  return dataList
}

async function calcFrameInfo(processDataInfo: ProcessData) {
  let filePathList = processDataInfo.processDataFileList
  let summaryOutputPath = processDataInfo.summaryoutputPath
  let summaryContentList: string[] = []

  let count = 1
  // 分析文件，暂时先跳过大于100MB的文件，因为解析速度比较慢
  for (let filePath of filePathList) {
    console.log(`=======filePath: ${filePath}=======`)
    if (statSync(filePath).size > 1024 * 1024 * 100) {
      console.log('file size > 100MB, skip')
      continue
    }
    let fileContent = readFileSync(filePath, 'utf-8')
    let fileName = filePath.split('/').pop()
    if (fileName == undefined) {
      fileName = 'undefined'
    }
    try {
      let logData = await ReadFileCalc(fileName, fileContent)
      logData.writeLog(filePath + '.log.txt')
      summaryContentList.push(fileName)
    } catch (e) {
      console.log(`exception: ${e}`)
    }
    writeFileSync(summaryOutputPath, summaryContentList.join('\n'))
    count++
    // if (count > 2) {
    //   break
    // }
  }
}

/**
 * 函数入口
 */
async function main() {
  for (let data of getDevToolData()) {
    await calcFrameInfo(data)
  }
  for (let data of getMobileMagicV2Data()) {
    await calcFrameInfo(data)
  }
}

main()
