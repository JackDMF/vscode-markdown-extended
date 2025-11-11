import { CommandConfig, Commands } from './commands';
import { editTables } from '../services/table/editTables';
import { EditType, TargetType } from '../services/table/editTable';


const cmds: CommandConfig[] = [
    {
        commandId: "markdownExtended.addRowAbove",
        worker: editTables,
        args: [EditType.Add, TargetType.Row, true]
    },
    {
        commandId: "markdownExtended.addRowBelow",
        worker: editTables,
        args: [EditType.Add, TargetType.Row, false]
    },
    {
        commandId: "markdownExtended.DeleteRow",
        worker: editTables,
        args: [EditType.Delete, TargetType.Row]
    },
    {
        commandId: "markdownExtended.addColumnLeft",
        worker: editTables,
        args: [EditType.Add, TargetType.Column, true]
    },
    {
        commandId: "markdownExtended.addColumnRight",
        worker: editTables,
        args: [EditType.Add, TargetType.Column, false]
    },
    {
        commandId: "markdownExtended.DeleteColumn",
        worker: editTables,
        args: [EditType.Delete, TargetType.Column]
    },
    {
        commandId: "markdownExtended.MoveColumnLeft",
        worker: editTables,
        args: [EditType.Move, TargetType.Column, true]
    },
    {
        commandId: "markdownExtended.MoveColumnRight",
        worker: editTables,
        args: [EditType.Move, TargetType.Column, false]
    },
]

export const commandTableEdits = new Commands(cmds);
