/* eslint-env mocha */
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { expect } from 'aegir/chai'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import all from 'it-all'
import drain from 'it-drain'
import { createLibp2p } from 'libp2p'
import { type AddPinEvents, createHelia } from '../src/index.js'
import { createDag, type DAGNode } from './fixtures/create-dag.js'
import { dagWalker } from './fixtures/dag-walker.js'
import type { Helia } from '@helia/interface'

describe('pins (recursive)', () => {
  let helia: Helia
  let dag: Record<string, DAGNode>

  beforeEach(async () => {
    const blockstore = new MemoryBlockstore()

    // arbitrary CID codec value
    const codec = 7

    // create a DAG, two levels deep with each level having three children
    dag = await createDag(codec, blockstore, 2, 3)

    helia = await createHelia({
      blockBrokers: [],
      datastore: new MemoryDatastore(),
      blockstore,
      libp2p: await createLibp2p({
        transports: [
          webSockets()
        ],
        connectionEncryption: [
          noise()
        ],
        streamMuxers: [
          yamux()
        ]
      }),
      dagWalkers: [
        dagWalker(codec, dag)
      ]
    })
  })

  afterEach(async () => {
    if (helia != null) {
      await helia.stop()
    }
  })

  it('pins a block recursively', async () => {
    await drain(helia.pins.add(dag['level-0'].cid))

    // all sub blocks should be pinned
    for (const [name, node] of Object.entries(dag)) {
      for (const cid of node.links) {
        await expect(helia.pins.isPinned(cid)).to.eventually.be.true(`did not pin ${name}`)
      }
    }
  })

  it('unpins recursively', async () => {
    await drain(helia.pins.add(dag['level-0'].cid))
    await drain(helia.pins.rm(dag['level-0'].cid))

    // no sub blocks should be pinned
    for (const [name, node] of Object.entries(dag)) {
      for (const cid of node.links) {
        await expect(helia.pins.isPinned(cid)).to.eventually.be.false(`did not unpin ${name}`)
      }
    }
  })

  it('does not delete a pinned sub-block', async () => {
    await drain(helia.pins.add(dag['level-0'].cid))

    // no sub blocks should be pinned
    for (const [name, node] of Object.entries(dag)) {
      for (const cid of node.links) {
        await expect(helia.blockstore.delete(cid)).to.eventually.be.rejected
          .with.property('message', 'CID was pinned', `allowed deleting pinned block ${name}`)
      }
    }
  })

  it('should not re-pin blocks pinned during an interrupted pinning operation', async () => {
    // the dag to pin has 13 nodes. We should abort after 5
    const firstTryEvents: AddPinEvents[] = []

    const pinIter = helia.pins.add(dag['level-0'].cid, {
      onProgress: (evt) => {
        if (evt.type === 'helia:pin:add') {
          firstTryEvents.push(evt)
        }

        if (firstTryEvents.length === 5) {
          throw new Error('Urk!')
        }
      }
    })

    let output = await pinIter.next()

    // read as much of the iterator as possible
    await expect((async () => {
      while (true) {
        output = await pinIter.next()
      }
    })()).to.eventually.be.rejected
      .with.property('message', 'Urk!')

    // we're not actually done. We simulated a crash
    expect(output.done).to.be.false()

    // we pinned the first 5 CIDs in the DAG
    expect(firstTryEvents.map(evt => evt.detail.toString()))
      .to.deep.equal([
        dag['level-0'].cid.toString(),
        dag['level-0'].links[0].toString(),
        dag['level-0-0'].links[0].toString(),
        dag['level-0-0'].links[1].toString(),
        dag['level-0-0'].links[2].toString()
      ])

    const secondTryEvents: AddPinEvents[] = []

    // now restart, and consume the entire iterator
    const pin = await all(helia.pins.add(dag['level-0'].cid, {
      onProgress: (evt) => {
        if (evt.type === 'helia:pin:add') {
          secondTryEvents.push(evt)
        }
      }
    }))

    // all blocks in the DAG should be pinned
    expect(pin).to.have.lengthOf(13)

    // we did not re-pin things we already pinned
    expect(secondTryEvents).to.have.lengthOf(pin.length - firstTryEvents.length)

    // these are the rest of the CIDs in the pinned DAG
    expect(secondTryEvents.map(evt => evt.detail.toString()))
      .to.deep.equal([
        dag['level-0'].links[1].toString(),
        dag['level-0-1'].links[0].toString(),
        dag['level-0-1'].links[1].toString(),
        dag['level-0-1'].links[2].toString(),
        dag['level-0'].links[2].toString(),
        dag['level-0-2'].links[0].toString(),
        dag['level-0-2'].links[1].toString(),
        dag['level-0-2'].links[2].toString()
      ])
  })
})
