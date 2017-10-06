import Graphcool, { fromEvent } from 'graphcool-lib'
import * as ws from 'ws'

let subscription: ws

export function withMutex(graphcool: any, region?:string) {
  graphcool.mutex = new Mutex(graphcool)

  if (region) {
    graphcool.mutex.subscriptionHostname = subscriptionEndpoints[region]
    return graphcool
  }
  else {
    const regionRequest = `
    query{
      viewer{
        project(id: "${graphcool.projectId}") {
          region
        }
      }
    }`

    const systemClient = graphcool.systemClient()
    systemClient.options.headers = { Authorization: `Bearer ${graphcool.pat}`}

    return systemClient.request(regionRequest).then(res => {
      graphcool.mutex.subscriptionHostname = subscriptionEndpoints[res.viewer.project.region]
      return graphcool
    })
  }
}

export default class Mutex {
  subscriptionHostname: string
  api: any
  projectId: string
  mutexId: number

  constructor(graphcool) {
    this.api = graphcool.api('simple/v1')
    this.projectId = graphcool.projectId
  }

  async acquire(name: string) {
      // Try to get the mutex
      const query = `query { Mutex(name: "${name}") { id } }`
      const result:any = await this.api.request(query)

      const existingMutex = result.Mutex != null

      if (existingMutex){
        this.mutexId = result.Mutex.id
        return setupSubscription(this.subscriptionHostname, name, this.projectId)
      }
      else {
        // Try to create the Mutex node
        const request = `mutation { createMutex(name: "${name}") { id } }`

        try {
          const result:any = await this.api.request(request)
          this.mutexId = result.createMutex.id
          return
        }
        catch(error){
          // Edge case where Mutex has been created in the meanwhile
          if (error.response.errors[0].code == 3010){
            return setupSubscription(this.subscriptionHostname, name, this.projectId)
          }
          else{
            throw new Error('Error creating Mutex record')
          }
        }
    }
  }

  release(name: string): void {
    if (subscription) {
      subscription.send(JSON.stringify({type: 'connection_terminate'}))
      subscription.close()
    }

    const request = `mutation { deleteMutex(id: "${this.mutexId}") { id } }`
    this.api.request(request).then(r => {return}).catch(e => {return})
  }
}

const subscriptionEndpoints = {
  EU_WEST_1: 'subscriptions.graph.cool',
  US_WEST_2: 'subscriptions.us-west-2.graph.cool',
  AP_NORTHEAST_1: 'subscriptions.ap-northeast-1.graph.cool',
}

function setupSubscription(subscriptionHostname: string, name: string, projectId: string): Promise<object> {

  // Setup the subscription
  const subscriptionEndpoint = `wss://${subscriptionHostname}/v1/${projectId}`
  subscription = new ws(subscriptionEndpoint, { protocol: 'graphql-ws' })

  return new Promise(async function(resolve, reject) {
    const subscriptionRequest = `
      subscription {
        Mutex(filter: { mutation_in: [DELETED], node: { name: "${name}"}}){
          previousValues{ name }
        }
      }`

    subscription.on('open', () => {
      // Send connection_init message on connection open
      subscription.send(JSON.stringify({type: 'connection_init'}))
    })

    subscription.on('message', (data) => {
      const message = JSON.parse(data)
      // Server sends connection_ack after connection_init
      // Send the subscription request
      if (message.type == "connection_ack") {
        const message = JSON.stringify({id: 'sub1', type: 'start', payload: { query: `${subscriptionRequest}` }})
        subscription.send(message)
      }
      // Check for subscription result we are looking for
      if (message.type == "data" &&
          message.id == "sub1" &&
          message.payload.data.Mutex.previousValues.name == name) {
        resolve()
      }
    })
  })
}