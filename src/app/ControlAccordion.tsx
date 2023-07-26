import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from "@mui/material";
import { observer } from "mobx-react-lite";
import { EndControl } from "../core/Path";
import { ObserverInput, clampQuantity } from "../component/ObserverInput";
import { Quantity, UnitOfAngle, UnitOfLength } from "../core/Unit";
import { UpdatePathTreeItems } from "../core/Command";
import { getAppStores } from "../core/MainApp";
import { NumberUOA, NumberUOL } from "../token/Tokens";
import { parseFormula } from "../core/Util";

const ControlAccordion = observer((props: {}) => {
  const { app } = getAppStores();

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>Control</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <Box id="control-editor">
          <Box className="flex-editor-panel">
            <ObserverInput
              label="X"
              getValue={() => {
                if (app.selectedEntityCount === 0) return "";
                if (app.selectedEntityCount > 1) return "(mixed)";
                const control = app.selectedControl;
                if (control === undefined) return "";
                return control.x.toUser().toString();
              }}
              setValue={(value: string) => {
                if (app.selectedEntityCount !== 1) return;
                const control = app.selectedControl;
                if (control === undefined) return;

                const controlUid = control.uid;
                const finalVal = clampQuantity(
                  parseFormula(value, NumberUOL.parse)!.compute(app.gc.uol),
                  app.gc.uol,
                  new Quantity(-1000, UnitOfLength.Centimeter),
                  new Quantity(1000, UnitOfLength.Centimeter)
                );

                app.history.execute(
                  `Update control ${controlUid} x value`,
                  new UpdatePathTreeItems([control], { x: finalVal })
                );
              }}
              isValidIntermediate={() => true}
              isValidValue={(candidate: string) => parseFormula(candidate, NumberUOL.parse) !== null}
              disabled={app.selectedEntityCount !== 1 || app.selectedControl === undefined}
              numeric
            />
            <ObserverInput
              label="Y"
              getValue={() => {
                if (app.selectedEntityCount === 0) return "";
                if (app.selectedEntityCount > 1) return "(mixed)";
                const control = app.selectedControl;
                if (control === undefined) return "";
                return control.y.toUser().toString();
              }}
              setValue={(value: string) => {
                if (app.selectedEntityCount !== 1) return;
                const control = app.selectedControl;
                if (control === undefined) return;

                const controlUid = control.uid;
                const finalVal = clampQuantity(
                  parseFormula(value, NumberUOL.parse)!.compute(app.gc.uol),
                  app.gc.uol,
                  new Quantity(-1000, UnitOfLength.Centimeter),
                  new Quantity(1000, UnitOfLength.Centimeter)
                );

                app.history.execute(
                  `Update control ${controlUid} y value`,
                  new UpdatePathTreeItems([control], { y: finalVal })
                );
              }}
              isValidIntermediate={() => true}
              isValidValue={(candidate: string) => parseFormula(candidate, NumberUOL.parse) !== null}
              disabled={app.selectedEntityCount !== 1 || app.selectedControl === undefined}
              numeric
            />
            <ObserverInput
              label="Heading"
              getValue={() => {
                if (app.selectedEntityCount === 0) return "";
                if (app.selectedEntityCount > 1) return "(mixed)";
                const control = app.selectedControl;
                if (!(control instanceof EndControl)) return "";
                return control.heading.toUser().toString();
              }}
              setValue={(value: string) => {
                if (app.selectedEntityCount !== 1) return;
                const control = app.selectedControl;
                if (!(control instanceof EndControl)) return;

                const controlUid = control.uid;
                const finalVal = parseFormula(value, NumberUOA.parse)!.compute(UnitOfAngle.Degree).toUser();

                app.history.execute(
                  `Update control ${controlUid} heading value`,
                  new UpdatePathTreeItems([control], { heading: finalVal })
                );
              }}
              isValidIntermediate={() => true}
              isValidValue={(candidate: string) => parseFormula(candidate, NumberUOA.parse) !== null}
              disabled={app.selectedEntityCount !== 1 || app.selectedControl === undefined}
              sx={{
                visibility:
                  app.selectedEntityCount === 1 && !(app.selectedControl instanceof EndControl) ? "hidden" : ""
              }}
              numeric
            />
          </Box>
        </Box>
      </AccordionDetails>
    </Accordion>
  );
});

export { ControlAccordion };
