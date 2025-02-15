import type { RxCollection, RxDatabase, RxLocalDocument } from '../../types';
import { Observable } from 'rxjs';
/**
 * save the local-document-data
 * throws if already exists
 */
export declare function insertLocal<DocData = any>(this: RxDatabase | RxCollection, id: string, data: DocData): Promise<RxLocalDocument<DocData>>;
/**
 * save the local-document-data
 * overwrites existing if exists
 */
export declare function upsertLocal<DocData = any>(this: any, id: string, data: DocData): Promise<RxLocalDocument<DocData>>;
export declare function getLocal<DocData = any>(this: any, id: string): Promise<RxLocalDocument<DocData> | null>;
export declare function getLocal$<DocData = any>(this: RxCollection, id: string): Observable<RxLocalDocument<DocData> | null>;
