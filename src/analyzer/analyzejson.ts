import {readFileSync, readdirSync, statSync} from 'fs'
import {importProfileGroupFromText} from '../import'
import {CallTreeNode, Frame, Profile} from '../lib/profile'
// import {getChronoViewFlamechart} from '../views/flamechart-view-container'
import {Flamechart} from '../lib/flamechart'

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
      return
    }

    // let x = {profile: targetProfile, getColorBucketForFrame: () => 0}
    // let flameChart = getChronoViewFlamechart(x)
    // flameChart.getLayers()

    let getColorBucketForFrame = function (f: Frame) {
      return 0
    }
    let flameChart = new Flamechart({
      getTotalWeight: targetProfile.getTotalWeight.bind(targetProfile),
      forEachCall: targetProfile.forEachCall.bind(targetProfile),
      formatValue: targetProfile.formatValue.bind(targetProfile),
      getColorBucketForFrame,
    })
    let callTreeNodeMap = new Map()
    let layerStack = flameChart.getLayers()
    for (let stackLine of layerStack) {
      for (let flameChartFrame of stackLine) {
        if (callTreeNodeMap.has(flameChartFrame.node)) {
          console.log('重复的node')
        }
        callTreeNodeMap.set(flameChartFrame.node, flameChartFrame)
      }
    }
    let totalWeight = targetProfile.getTotalWeight()
    // 权重占比记录 单位是微妙
    let weightDict: {[key: string]: number} = {}
    let frameInterval = -1
    let callUnityWeight = 0
    // appendTree 是按照时间排序的调用树，从早到晚，从上到下，取出来的root是个总体root，root的child才是真正的调用
    let root = targetProfile.getAppendOrderCalltreeRoot()
    for (let i = 0; i < root.children.length; i++) {
      let child = root.children[i]
      frameInterval = -1
      if (i < root.children.length - 1) {
        let currFlameChartFrame = callTreeNodeMap.get(child)
        let nextFlameChartFrame = callTreeNodeMap.get(root.children[i + 1])
        if (nextFlameChartFrame != null && currFlameChartFrame != null) {
          frameInterval = nextFlameChartFrame.start - currFlameChartFrame.start
        } else {
          console.log(
            `nextFlameChartFrame ${nextFlameChartFrame} or currFlameChartFrame ${currFlameChartFrame} is null`,
          )
          console.log(`${child} ${root.children[i + 1]}`)
        }
      }
      // 检查此时是否回调到了Unity
      let isCallUnity = CheckCallUnity(child)
      if (isCallUnity) {
        callUnityWeight += child.getTotalWeight()
      }
      let tempWeightDict: {[key: string]: number} = {}
      CheckBaseBehaviourManager(child, tempWeightDict)
      if (frameInterval > 0) {
      }
    }
    console.log(
      `fileName ${fileName}, 录制时长（秒）: ${(totalWeight / 1000 / 1000).toFixed(
        2,
      )}, 回调Unity时长（秒）: ${(callUnityWeight / 1000 / 1000).toFixed(2)}, 时长占比: ${(
        callUnityWeight / totalWeight
      ).toFixed(2)}`,
    )
    let keyList = Object.keys(weightDict).sort()
    for (let key of keyList) {
      console.log(
        `key: ${key}, 录制时长（秒）: ${(weightDict[key] / 1000 / 1000).toFixed(2)}, 占总比: ${(
          weightDict[key] / totalWeight
        ).toFixed(2)}，占Unity比: ${(weightDict[key] / callUnityWeight).toFixed(2)}`,
      )
    }
  })
}

function CheckCallUnity(childNode: CallTreeNode): boolean {
  if (childNode.frame.name.includes('cbWithTimeStamp')) {
    return true
  }
  for (let child of childNode.children) {
    if (CheckCallUnity(child)) {
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
  // CommonUpdate<xxx>有三种Update LateUpdate FixedUpdate， 『c++filt』工具能反向解析出函数名
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

  // 从Hybridclr目录里取文件名
  let fileDir = '/Users/admin/WorkProjects/WeChatProjects/Profiler/HybridCLR/'
  let files = readdirSync(fileDir)
  for (let fileName of files) {
    filePathList.push(fileDir + fileName)
  }
  // 从il2cpp目录里取文件名
  let fileDir2 = '/Users/admin/WorkProjects/WeChatProjects/Profiler/il2cpp/'
  let files2 = readdirSync(fileDir2)
  for (let fileName of files2) {
    filePathList.push(fileDir2 + fileName)
  }

  let count = 1
  // 分析文件，暂时先跳过大于100MB的文件，因为解析速度比较慢
  for (let filePath of filePathList) {
    console.log(`filePath: ${filePath}`)
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
      console.log(e)
    }
    count++
    if (count > 2) {
      break
    }
  }
}

Main()
