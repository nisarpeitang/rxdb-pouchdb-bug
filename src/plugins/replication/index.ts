import {
    BehaviorSubject,
    firstValueFrom,
    Observable,
    Subject,
    Subscription
} from 'rxjs';
import {
    filter
} from 'rxjs/operators';
import type {
    DeepReadonlyObject,
    ReplicationOptions,
    ReplicationPullHandlerResult,
    ReplicationPullOptions,
    ReplicationPushOptions,
    RxCollection,
    RxDocumentData,
    RxReplicationState,
    WithDeleted
} from '../../types';
import {
    getChangesSinceLastPushSequence,
    getLastPullDocument,
    setLastPullDocument,
    setLastPushSequence
} from './replication-checkpoint';
import {
    flatClone,
    getHeightOfRevision,
    lastOfArray,
    promiseWait,
    PROMISE_RESOLVE_FALSE,
    PROMISE_RESOLVE_TRUE,
    PROMISE_RESOLVE_VOID
} from '../../util';
import { overwritable } from '../../overwritable';
import {
    createRevisionForPulledDocument,
    wasRevisionfromPullReplication
} from './revision-flag';
import { _handleToStorageInstance } from '../../rx-collection-helper';
import { newRxError } from '../../rx-error';
import { getDocumentDataOfRxChangeEvent } from '../../rx-change-event';


export class RxReplicationStateBase<RxDocType> {
    public readonly subs: Subscription[] = [];
    public initialReplicationComplete$: Observable<any> = undefined as any;

    private subjects = {
        received: new Subject(), // all documents that are received from the endpoint
        send: new Subject(), // all documents that are send to the endpoint
        error: new Subject(), // all errors that are received from the endpoint, emits new Error() objects
        canceled: new BehaviorSubject(false), // true when the replication was canceled
        active: new BehaviorSubject(false), // true when something is running, false when not
        initialReplicationComplete: new BehaviorSubject(false) // true the initial replication-cycle is over
    };

    private runningPromise: Promise<void> = PROMISE_RESOLVE_VOID;
    private runQueueCount: number = 0;
    /**
     * Counts how many times the run() method
     * has been called. Used in tests.
     */
    public runCount: number = 0;

    constructor(
        public readonly replicationIdentifier: string,
        public readonly collection: RxCollection<RxDocType>,
        public readonly pull?: ReplicationPullOptions<RxDocType>,
        public readonly push?: ReplicationPushOptions<RxDocType>,
        public readonly live?: boolean,
        public liveInterval?: number,
        public retryTime?: number,
    ) {

        // stop the replication when the collection gets destroyed
        this.collection.onDestroy.then(() => {
            this.cancel();
        });

        // create getters for the observables
        Object.keys(this.subjects).forEach(key => {
            Object.defineProperty(this, key + '$', {
                get: function () {
                    return this.subjects[key].asObservable();
                }
            });
        });
    }

    isStopped(): boolean {
        if (this.collection.destroyed) {
            return true;
        }
        if (!this.live && this.subjects.initialReplicationComplete.getValue()) {
            return true;
        }
        if (this.subjects.canceled['_value']) {
            return true;
        }

        return false;
    }

    awaitInitialReplication(): Promise<true> {
        return firstValueFrom(
            this.initialReplicationComplete$.pipe(
                filter(v => v === true),
            )
        );
    }

    cancel(): Promise<any> {
        if (this.isStopped()) {
            return PROMISE_RESOLVE_FALSE;
        }
        this.subs.forEach(sub => sub.unsubscribe());
        this.subjects.canceled.next(true);
        return PROMISE_RESOLVE_TRUE;
    }

    /**
     * Ensures that this._run() does not run in parallel
     */
    async run(retryOnFail = true): Promise<void> {
        if (this.isStopped()) {
            return;
        }

        if (this.runQueueCount > 2) {
            return this.runningPromise;
        }

        this.runQueueCount++;
        this.runningPromise = this.runningPromise.then(async () => {
            this.subjects.active.next(true);
            const willRetry = await this._run(retryOnFail);
            this.subjects.active.next(false);
            if (
                retryOnFail &&
                !willRetry &&
                this.subjects.initialReplicationComplete.getValue() === false
            ) {
                this.subjects.initialReplicationComplete.next(true);
            }
            this.runQueueCount--;
        });
        return this.runningPromise;
    }

    /**
     * Runs the whole cycle once,
     * first pushes the local changes to the remote,
     * then pulls the remote changes to the local.
     * Returns true if a retry must be done
     */
    async _run(retryOnFail = true): Promise<boolean> {
        this.runCount++;

        /**
         * The replication happens in the background anyways
         * so we have to ensure that we do not slow down primary tasks.
         * But not if it is the initial replication, because that might happen
         * on the first inital loading where it is critical to get the data
         * as fast as possible to decrease initial page load time.
         */
        if (this.subjects.initialReplicationComplete.getValue()) {
            await this.collection.database.requestIdlePromise();
        }

        if (this.push) {
            const ok = await this.runPush();
            if (!ok && retryOnFail) {
                setTimeout(() => this.run(), this.retryTime);
                /*
                    Because we assume that conflicts are solved on the server side,
                    if push failed, do not attempt to pull before push was successful
                    otherwise we do not know how to merge changes with the local state
                */
                return true;
            }
        }

        if (this.pull) {
            const ok = await this.runPull();
            if (!ok && retryOnFail) {
                setTimeout(() => this.run(), this.retryTime);
                return true;
            }
        }

        return false;
    }

    /**
     * Pull all changes from the server,
     * start from the last pulled change.
     * @return true if successfully, false if something errored
     */
    async runPull(): Promise<boolean> {
        if (!this.pull) {
            throw newRxError('SNH');
        }
        if (this.isStopped()) {
            return PROMISE_RESOLVE_FALSE;
        }

        const latestDocument = await getLastPullDocument(this.collection, this.replicationIdentifier);

        let result: ReplicationPullHandlerResult<RxDocType>;

        try {
            result = await this.pull.handler(latestDocument);
        } catch (err) {
            this.subjects.error.next(err);
            return false;
        }

        const pulledDocuments = result.documents;

        // optimization shortcut, do not proceed if there are no documents.
        if (pulledDocuments.length === 0) {
            return true;
        }

        /**
         * Run schema validation in dev-mode
         */
        if (overwritable.isDevMode()) {
            try {
                pulledDocuments.forEach((doc: any) => {
                    const withoutDeleteFlag = flatClone(doc);
                    delete withoutDeleteFlag._deleted;
                    this.collection.schema.validate(withoutDeleteFlag);
                });
            } catch (err) {
                this.subjects.error.next(err);
                return false;
            }
        }

        if (this.isStopped()) {
            return true;
        }
        await this.handleDocumentsFromRemote(pulledDocuments);
        pulledDocuments.map((doc: any) => this.subjects.received.next(doc));


        if (pulledDocuments.length === 0) {
            if (this.live) {
                // console.log('no more docs, wait for ping');
            } else {
                // console.log('RxGraphQLReplicationState._run(): no more docs and not live; complete = true');
            }
        } else {
            const newLatestDocument = lastOfArray(pulledDocuments);
            await setLastPullDocument(
                this.collection,
                this.replicationIdentifier,
                newLatestDocument
            );

            /**
             * We have more documents on the remote,
             * So re-run the pulling.
             */
            if (result.hasMoreDocuments) {
                await this.runPull();
            }
        }

        return true;
    }

    async handleDocumentsFromRemote(
        docs: (WithDeleted<RxDocType> | DeepReadonlyObject<WithDeleted<RxDocType>>)[]
    ): Promise<boolean> {
        const toStorageDocs: RxDocumentData<RxDocType>[] = [];
        const docIds: string[] = docs.map(doc => doc[this.collection.schema.primaryPath]) as any;
        const docsFromLocal = await this.collection.storageInstance.findDocumentsById(docIds, true);

        for (const originalDoc of docs) {
            const doc: any = flatClone(originalDoc);
            const documentId: string = doc[this.collection.schema.primaryPath];

            const docStateInLocalStorageInstance = docsFromLocal.get(documentId);
            let newRevision = createRevisionForPulledDocument(
                this.replicationIdentifier,
                doc
            );
            if (docStateInLocalStorageInstance) {
                const hasHeight = getHeightOfRevision(docStateInLocalStorageInstance._rev);
                const newRevisionHeight = hasHeight + 1;
                newRevision = newRevisionHeight + '-' + newRevision;
            } else {
                newRevision = '1-' + newRevision;
            }
            doc._rev = newRevision;

            toStorageDocs.push(doc);
        }

        if (toStorageDocs.length > 0) {
            await this.collection.database.lockedRun(
                async () => {
                    await this.collection.storageInstance.bulkAddRevisions(
                        toStorageDocs.map(doc => _handleToStorageInstance(this.collection, doc))
                    );
                }
            );
        }

        return true;
    }

    /**
     * Pushes unreplicated local changes to the remote.
     * @return true if successfull, false if not
     */
    async runPush(): Promise<boolean> {
        if (!this.push) {
            throw newRxError('SNH');
        }

        const batchSize = this.push.batchSize ? this.push.batchSize : 5;
        const changesResult = await getChangesSinceLastPushSequence<RxDocType>(
            this.collection,
            this.replicationIdentifier,
            batchSize,
        );

        const pushDocs: WithDeleted<RxDocType>[] = Array
            .from(changesResult.changedDocs.values())
            .map(row => {
                const doc: WithDeleted<RxDocType> = flatClone(row.doc) as any;
                // TODO _deleted should be required on type RxDocumentData
                // so we do not need this check here
                if (!doc.hasOwnProperty('_deleted')) {
                    doc._deleted = false;
                }

                delete (doc as any)._rev;
                delete (doc as any)._attachments;

                return doc;
            });

        try {
            await this.push.handler(pushDocs);
        } catch (err) {
            this.subjects.error.next(err);
            return false;
        }

        pushDocs.forEach(pushDoc => this.subjects.send.next(pushDoc));

        await setLastPushSequence(
            this.collection,
            this.replicationIdentifier,
            changesResult.lastSequence
        );

        // batch had documents so there might be more changes to replicate
        if (changesResult.changedDocs.size !== 0) {
            await this.runPush();
        }

        return true;
    }
}


export async function replicateRxCollection<RxDocType>(
    {
        replicationIdentifier,
        collection,
        pull,
        push,
        live = false,
        liveInterval = 1000 * 10,
        retryTime = 1000 * 5,
        waitForLeadership
    }: ReplicationOptions<RxDocType>
): Promise<RxReplicationState<RxDocType>> {

    if (
        waitForLeadership &&
        // do not await leadership if not multiInstance
        collection.database.multiInstance
    ) {
        await collection.database.waitForLeadership();
    }

    const replicationState = new RxReplicationStateBase<RxDocType>(
        replicationIdentifier,
        collection,
        pull,
        push,
        live,
        liveInterval,
        retryTime,
    );

    // trigger run once
    replicationState.run();

    // start sync-interval
    if (replicationState.live) {
        if (pull) {
            (async () => {
                while (!replicationState.isStopped()) {
                    await promiseWait(replicationState.liveInterval);
                    if (replicationState.isStopped()) {
                        return;
                    }
                    await replicationState.run(
                        // do not retry on liveInterval-runs because they might stack up
                        // when failing
                        false
                    );
                }
            })();
        }

        if (push) {
            /**
             * When a document is written to the collection,
             * we might have to run the replication run() once
             */
            const changeEventsSub = collection.$.pipe(
                filter(cE => !cE.isLocal)
            )
                .subscribe(changeEvent => {
                    if (replicationState.isStopped()) {
                        return;
                    }
                    const doc = getDocumentDataOfRxChangeEvent(changeEvent);
                    const rev = doc._rev;
                    if (
                        rev &&
                        !wasRevisionfromPullReplication(
                            replicationIdentifier,
                            rev
                        )
                    ) {
                        replicationState.run();
                    }
                });
            replicationState.subs.push(changeEventsSub);
        }
    }

    return replicationState as any;
}

export * from './replication-checkpoint';
export * from './revision-flag';
