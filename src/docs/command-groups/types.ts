import type { DeveloperPermissionCode } from '../../developer-permissions'
import type { ListCapabilities } from '../../list-capabilities'
import type {
  CommandSpec,
  HelpArgument,
  HelpExample,
  HelpOption,
  NetworkContract
} from '../commands'

export interface CommandSpecBuilder {
  add: (spec: CommandSpec) => void
  apiAction: (
    path: string[],
    summary: string,
    network: NetworkContract,
    permissions: DeveloperPermissionCode[],
    extra?: Partial<CommandSpec>
  ) => void
  argument: (name: string, description: string, required?: boolean, values?: string[]) => HelpArgument
  categoryNameDiscovery: string
  collectionGetBehavior: string
  dataOption: HelpOption
  downloadRequestOptions: HelpOption[]
  dryRunOption: HelpOption
  example: (command: string, purpose: string) => HelpExample
  formatOption: HelpOption
  gameOption: HelpOption
  group: (path: string, summary: string, behavior?: string[]) => void
  listOptionsFor: (capabilities: ListCapabilities) => HelpOption[]
  listViewOptions: HelpOption[]
  mutationOptions: HelpOption[]
  option: (name: string, type: string, description: string, extra?: Omit<HelpOption, 'name' | 'type' | 'description'>) => HelpOption
  outputOptions: HelpOption[]
  requestMutationOptions: HelpOption[]
  requestOptions: HelpOption[]
  testingAudienceDiscovery: string
  timeoutOption: HelpOption
  uploadMutationOptions: HelpOption[]
  waitOptions: (subject: string) => HelpOption[]
  yesOption: HelpOption
}
