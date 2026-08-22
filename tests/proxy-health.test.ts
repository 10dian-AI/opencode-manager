import { describe, expect, test } from 'bun:test'
import { calculateProxyHealthState } from '../server/utils/proxy-health'

describe('proxy health state transitions', () => {
  test('marks a node down after three consecutive over-threshold samples', () => {
    expect(calculateProxyHealthState({
      previousHealth: 'healthy',
      previousStreak: 0,
      overCount: 3
    })).toEqual({
      previousHealth: 'healthy',
      streak: 3,
      health: 'down',
      switched: true,
      recovered: false
    })
  })

  test('keeps an unknown node pending before the third failure', () => {
    expect(calculateProxyHealthState({
      previousHealth: 'unknown',
      previousStreak: 0,
      overCount: 2
    })).toMatchObject({ streak: 2, health: 'unknown', switched: false })
  })

  test('a successful sample clears the streak and recovers a down node', () => {
    expect(calculateProxyHealthState({
      previousHealth: 'down',
      previousStreak: 7,
      overCount: 0
    })).toEqual({
      previousHealth: 'down',
      streak: 0,
      health: 'healthy',
      switched: false,
      recovered: true
    })
  })
})
