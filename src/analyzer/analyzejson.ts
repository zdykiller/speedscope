import {readFileSync, readdirSync, statSync} from 'fs'
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
   * 排序分位数，并取结果
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

async function ReadFileCalc(fileName: string, fileContent: string) {
  let promise = importProfileGroupFromText(fileName, fileContent)
  await promise.then(res => {
    if (res == null) {
      return
    }
    let targetProfile: Profile | null = null
    for (let profile of res.profiles) {
      if (profile.getName().includes('CrRendererMain')) {
        targetProfile = profile
        break
      }
    }
    if (targetProfile == null) {
      console.error(`解析失败 ${fileName}`)
      return
    }

    // let totalWeight = targetProfile.getTotalWeight()
    // appendTree 是按照时间排序的调用树，从早到晚，从上到下，取出来的root是个总体root，root的child才是真正的调用
    // let root = targetProfile.getAppendOrderCalltreeRoot()

    let getColorBucketForFrame = function (f: Frame) {
      return 0
    }

    // 获取火焰图信息
    let flameChart = new Flamechart({
      getTotalWeight: targetProfile.getTotalWeight.bind(targetProfile),
      forEachCall: targetProfile.forEachCall.bind(targetProfile),
      formatValue: targetProfile.formatValue.bind(targetProfile),
      getColorBucketForFrame,
    })
    // layers按层记录，二维数组，内部每个数组对应火焰图的一行的所有条块，外部数组记录每行
    let layerStack = flameChart.getLayers()
    let firstLine = layerStack[0]

    let callUnityWeight = 0
    let callUnityCount = 0

    let frameInfoList: FrameInfo[] = []
    let collectDict: {[key: string]: string} = {}

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
      // 检查此时是否回调到了Unity，特点是必定有cbWithTimeStamp函数
      let isCallUnity = isCallFunc(child, 'cbWithTimeStamp')
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

    let calcTool = new FrameCalcTool()
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
      console.log(`${k}`)
      console.log(`记录次数 ${frameList.length}`)
      console.log(`分位数配置 ${quantile.join('-')}`)
      console.log(`分位数结果(ms) ${resultList.join('-')}`)
    }

    // 总时长（秒）
    let timeSecond = (flameChart.getTotalWeight() / 1000 / 1000).toFixed(2)
    // 调用unity的时长（秒）
    let callUnitySecond = (callUnityWeight / 1000 / 1000).toFixed(2)
    // unity帧执行占总时间的比
    let ratio = (callUnityWeight / flameChart.getTotalWeight()).toFixed(2)
    console.log(`文件名 ${fileName}`)
    console.log(`录制时长（秒）: ${timeSecond}`)
    console.log(
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
}

/**
 * 调用了查询整个调用栈是否调用了数据
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
 * 函数入口
 * @constructor
 */
async function Main() {
  // let filePath =
  //   '/Users/admin/WorkProjects/WeChatProjects/Profiler/HybridCLR/hybridclr-Profile-20240330T114746-大号-竞技场-战斗-有战斗画面_副本.json'
  // let fileContent = readFileSync(filePath, 'utf-8')
  let filePathList = []

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

  // 从Hybridclr目录里取文件名
  let fileDir = '/Users/admin/WorkProjects/WeChatProjects/Profiler/HybridCLR'
  let files = readdirSync(fileDir)
  files.sort(sortFunc)
  for (let fileName of files) {
    filePathList.push(fileDir + '/' + fileName)
  }

  // 从il2cpp目录里取文件名
  let fileDir2 = '/Users/admin/WorkProjects/WeChatProjects/Profiler/il2cpp'
  let files2 = readdirSync(fileDir2)
  // 给文件名排序
  files2.sort(sortFunc)
  for (let fileName of files2) {
    filePathList.push(fileDir2 + '/' + fileName)
  }

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
      await ReadFileCalc(fileName, fileContent)
    } catch (e) {
      console.log(`exception: ${e}`)
    }
    count++
    // if (count > 2) {
    //   break
    // }
  }
}

Main()
