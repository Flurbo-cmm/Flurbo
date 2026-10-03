#!/usr/bin/env node
import { main } from '../src/node/cli.ts';

process.exitCode = await main(process.argv.slice(2));
