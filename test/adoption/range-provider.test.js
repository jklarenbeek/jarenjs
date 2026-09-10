//@ts-check
import { rangeProviderContract } from './range-provider-contract.js';
import { fakeRangeProvider } from './fake-range-provider.js';

rangeProviderContract('scripted source (real adapters pending)', fakeRangeProvider);
