const request = require('supertest')
const ngrok = require('ngrok')

const { getAccessTokenHeaders } = require('./auth')

const delay = duration => new Promise(resolve => setTimeout(resolve, duration))
const noop = () => Promise.resolve()

// Utility to test external service webhooks integration into Stelace
// Two modes of functioning:
// - test webhooks for real via Ngrok
// - simulate webhooks by fetching and creating events
//    (suitable if webhooks cannot be created via API and one cannot have access to Ngrok paid plan
//     for reserved subdomains)
class WebhookManager {
  /**
   * @param {Object}   params
   * @param {Object}   params.t - AVA test object
   * @param {Boolean}  [params.isWebhookSimulated = true]
   *
   * @param {Function} [params.createEvent] - required if isWebhookSimulated is true
   * @param {Function} [params.listEvents] - required if isWebhookSimulated is true
   *
   * @param {Function} [params.createWebhook] - can be provided if isWebhookSimulated is false
   * @param {Function} [params.removeWebhook] - can be provided if isWebhookSimulated is false
   *
   * Please refer to ngrok options (https://github.com/bubenshchykov/ngrok#options)
   * @param {Object}   [params.tunnel]
   * @param {String}   [params.tunnel.subdomain]
   * @param {String}   [params.tunnel.auth]
   * @param {String}   [params.tunnel.authToken]
   */
  constructor ({ t, isWebhookSimulated = true, tunnel, createEvent, listEvents, createWebhook, removeWebhook }) {
    this.t = t

    // minus one second to handle cases events are generated during the same second of webhook manager creation
    this.lastEventTimestamp = getTimestamp() - 1

    this.isWebhookSimulated = isWebhookSimulated
    this.tunnel = tunnel || {}

    this.createEvent = createEvent
    this.listEvents = listEvents
    this.createWebhook = createWebhook || noop
    this.removeWebhook = removeWebhook || noop
  }

  async start () {
    if (this.isWebhookSimulated) {
      if (!this.createEvent || !this.listEvents) {
        throw new Error('Functions `createEvent` and `listEvents` expected')
      }
    }

    if (this.isWebhookSimulated) return

    // https://github.com/bubenshchykov/ngrok#connect
    this.tunnelUrl = await ngrok.connect({
      addr: this.t.context.serverPort,
      auth: this.tunnel.auth || undefined,
      subdomain: this.tunnel.subdomain || undefined,
      authtoken: this.tunnel.authToken || undefined
    })

    await this.createWebhook(this.tunnelUrl)
  }

  async stop () {
    if (this.isWebhookSimulated) return

    // https://github.com/bubenshchykov/ngrok#disconnect
    await ngrok.disconnect(this.tunnelUrl)
  }

  // if isWebhookSimulated is false, really wait webhooks events
  // otherwise, fetch events not retrieved from last time to simulate a real webhook running
  async waitForEvents (waitDurationMs = 10000) {
    // give enough time for external service events to be created
    await delay(waitDurationMs)

    if (!this.isWebhookSimulated) return

    const events = await this.listEvents(this.lastEventTimestamp)

    this.lastEventTimestamp = getTimestamp()

    for (const event of events) {
      await this.createEvent(event)
    }

    // give enough time for Stelace events to be created
    await delay(waitDurationMs)
  }

  // expose this function as convenience
  // can be used to update private config with webhook secret for instance
  async updatePrivateConfig (payload) {
    const authorizationHeaders = await getAccessTokenHeaders({
      t: this.t,
      permissions: ['config:edit:all']
    })

    return request(this.t.context.serverUrl)
      .patch('/config/private')
      .send(payload)
      .set(authorizationHeaders)
      .expect(200)
  }
}

function getTimestamp () {
  return Math.round(new Date().getTime() / 1000)
}

module.exports = WebhookManager
