import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { TurnscopeHostApi } from './host-api.ts';
import { type RecordedTurns } from './recorded-turns.ts';
/** The props the view needs beyond what the slot framework hands it. */
export interface TurnscopeViewProps {
    /**
     * The host's rows for this session, absent while the first answer is in flight.
     *
     * A prop rather than a fetch inside the view so that the pure rendering can be
     * tested — and read — without a connection, a timer, or a resolved promise.
     */
    readonly recorded?: RecordedTurns | undefined;
    /** Ask the host again. Absent in renders that are not wired to a host. */
    readonly onRefresh?: (() => void) | undefined;
}
export declare function TurnscopeView({ useSession, t, recorded, onRefresh, }: ConvViewProps & PropsLocale<'turnscope'> & TurnscopeViewProps): import("react/jsx-runtime").JSX.Element;
/**
 * Bind the view to a live host.
 *
 * A factory rather than a component with a `host` prop, because the host is a
 * property of *this installation* and not of any render: it is created once when
 * the plugin applies, from the connection the platform handed us, and never
 * changes while the page is open. Threading it through props would put a value
 * that cannot vary into a position where it looks like it can.
 */
export declare function createTurnscopeView(host: TurnscopeHostApi): (props: ConvViewProps & PropsLocale<"turnscope">) => import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=TurnscopeView.d.ts.map