$(function() {

    var learn = true;
    var playing = false;
    var noise = 0.00;

    var spClient;
    var tmClient;
    var computeClient;

    // SP params we are not allowing user to change
    var inputDimensions = [100];
    var columnDimensions = [1024];
    var cellsPerColumn = 8;
    var spParams = new HTM.utils.sp.Params(
        'sp-params', inputDimensions, columnDimensions
    );

    var counter = 0;
    var bucketLabels = [];

    var $loading = $('#loading');
    // Indicates we are still waiting for a response from the server SP.
    var waitingForServer = false;

    // Set up an globals for sound sequencer settings.
    var sequence = [];
    var keys = undefined;
    var noteNames = undefined;
    var grid = undefined;
    var beats = 8;
    var padCount = 4;
    var loop;
    var lastBeat = beats - 1;
    var bpm = 45;

    // Turns on/off column and cell selection modes.
    var columnSelection = false;
    // var cellSelection = true;

    var cellStates = {
        inactive: {
            state: 'inactive',
            color: new THREE.Color('#FFFEEE'),
            description: 'cell is inactive'
        },
        withinActiveColumn: {
            state: 'withinActiveColumn',
            color: new THREE.Color('yellow'),
            description: 'cell is inactive, but within a currently active column'
        },
        active: {
            state: 'active',
            color: new THREE.Color('orange'),
            description: 'cell is active, but was not predicted last step'
        },
        correctlyPredicted: {
            state: 'correctlyPredicted',
            color: new THREE.Color('limegreen'),
            description: 'cell is active and was correctly predicted last step'
        },
        predictiveActive: {
            state: 'predictiveActive',
            color: new THREE.Color('indigo'),
            description: 'cell is active and predictive'
        },
        predictive: {
            state: 'predictive',
            color: new THREE.Color('blue'),
            description: 'cell is predicted to be active on the next time step'
        },
        wronglyPredicted: {
            state: 'wronglyPredicted',
            color: new THREE.Color('red'),
            description: 'cell was predicted to be active, but was not'
        },
        input: {
            state: 'input',
            color: new THREE.Color('green'),
            description: 'input bit is on'
        }
    };

    var defaultSpCellSpacing = {
        x: 1.1, y: 1.1, z: 1.1
    };
    // var defaultCellsPerRow = Math.floor(Math.sqrt(columnDimensions[0]));
    var defaultCellsPerRow = 30;

    // One-step in the past.
    var lastPredictedCells = [];

    ////////////////////////////////////////////////////////////////////////////
    // These globals contain the HTM state that gets displayed on the cell
    // visualization. They get updated with every HTM cycle, and they are used
    // by the rendered to paint the visualization.
    ////////////////////////////////////////////////////////////////////////////

    // The HtmCells objects that contains cell state. This is the inteface for
    // making changes to cell-viz.
    var inputCells, spColumns;
    // The Viz object.
    var cellviz;
    // The raw HTM state being sent from the server.
    var htmState;

    ////////////////////////////////////////////////////////////////////////////
    // Utility functions
    ////////////////////////////////////////////////////////////////////////////

    function getRandomInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min)) + min;
    }

    function countIntsIntoArray(size) {
        var out = [];
        _.times(size, function(count) {
            out.push(count);
        });
        return out;
    }

    /* From http://stackoverflow.com/questions/7128675/from-green-to-red-color-depend-on-percentage */
    function getGreenToRed(percent){
        var r, g;
        percent = 100 - percent;
        r = percent < 50 ? 255 : Math.floor(255-(percent*2-100)*255/100);
        g = percent > 50 ? 255 : Math.floor((percent*2)*255/100);
        return new THREE.Color(r, g, 0);
    }

    function averageRGB(c1, c2) {
        return c1.clone().lerp(c2, 0.5);
    }

    function translate(x, min, max) {
        var range = max - min;
        return (x - min) / range;
    }

    function xyzToOneDimIndex(x, y, z, xMax, yMax, zMax) {
        var result = (z * xMax * yMax) + (y * xMax) + x;
        return result;
    }

    function cellXyToColumnIndex(x, y, xMax) {
        return y * xMax + x;
    }

    ////////////////////////////////////////////////////////////////////////////
    // UI functions
    ////////////////////////////////////////////////////////////////////////////

    function loading(isLoading, isModal) {
        if (isModal == undefined) {
            isModal = true;
        }
        if (isLoading) {
            waitingForServer = true;
            if (! isModal) {
                $loading.addClass('little');
            }
            $loading.show();
        } else {
            waitingForServer = false;
            $loading.hide();
            $loading.removeClass('little');
        }
    }

    function buildLegend() {
        var $legend = $('#legend ul');
        _.each(cellStates, function(state) {
            var $item = $('<li>');
            var $span = $('<span>');
            var $name = $('<p>' + state.description + '</p>');
            $span.css('background-color', '#' + state.color.getHexString());
            $span.appendTo($item);
            $name.appendTo($item);
            $item.appendTo($legend);
        });
    }

    function updatePredictions(beat) {
        // Display predictions on next beat.
        var predictedValue = htmState.inference[0][1];

        console.log('predicted notes: %s', predictedValue);

        var mark = '✘';
        var nextBeat = beat + 1;
        if (nextBeat >= beats) {
            nextBeat = 0;
        }

        var $nextInfoCell = grid.find('tr.info td.beat-' + nextBeat);
        $nextInfoCell.removeClass('correct');

        grid.find('td.note').removeClass('prediction');

        var $nextBeatCells = grid.find('.beat-' + nextBeat + '.on');
        var nextBeatNoteNames = [];
        _.each($nextBeatCells, function(cell) {
            nextBeatNoteNames.push(cell.innerHTML);
        });
        if (nextBeatNoteNames.join('-') == predictedValue
        || nextBeatNoteNames.length == 0 && predictedValue == 'rest') {
            mark = '✔';
            $nextInfoCell.addClass('correct');
        }

        _.each(predictedValue.split('-'), function(note) {
            var predictedPadIdx = noteNames.indexOf(note);
            grid.find('.beat-' + nextBeat + '.pad-' + predictedPadIdx)
                .addClass('prediction');
        });

        $nextInfoCell.html(mark);
    }

    function renderSequencerGrid(selector, beats, pads) {
        var $grid = $(selector);
        var $table = $('<table>');
        _.times(pads, function(pad) {
            var $row = $('<tr>');
            _.times(beats, function(beat) {
                var on = '';
                var $cell = $('<td class="note">');
                if (sequence[beat][pad] == 1) {
                    $cell.addClass('on');
                }
                $cell.data('beat', beat);
                $cell.data('pad', pad);
                $cell.addClass('beat-' + beat);
                $cell.addClass('pad-' + pad);
                $cell.html(noteNames[pad]);
                $row.append($cell);
            });
            $table.append($row);
        });
        // Add one more row for additional info about the beat.
        var $infoTr = $('<tr class="info">');
        _.times(beats, function(beat) {
            var $cell = $('<td>');
            $cell.addClass('beat-' + beat);
            $infoTr.append($cell);
        });
        $table.append($infoTr);
        $table.click(function(event) {
            event.preventDefault();
            event.stopPropagation();
            var $cell = $(event.target);
            var beat = $cell.data('beat');
            var pad = $cell.data('pad');
            if (beat != undefined && pad != undefined) {
                if (sequence[beat][pad] == 0) sequence[beat][pad] = 1;
                else sequence[beat][pad] = 0;
                $cell.toggleClass('on');
            }
        });
        $grid.append($table);
        return $grid;
    }

    function addDataControlHandlers() {
        $('.player button').click(function(evt) {
            var $btn = $(this);
            var nextBeat;
            if (this.id == 'play') {
                if ($btn.hasClass('btn-success')) {
                    pause();
                    $btn.find('span').attr('class', 'glyphicon glyphicon-play');
                } else {
                    play();
                    $btn.find('span').attr('class', 'glyphicon glyphicon-pause');
                }
                $btn.toggleClass('btn-success');
            } else if (this.id == 'next') {
                nextBeat = lastBeat + 1;
                if (nextBeat >= beats) {
                    nextBeat = 0;
                }
                processOneBeat(new Tone.Time().addNow(), nextBeat);
            }
        });
    }

    function addClickHandling() {

        function inputClicked(cellData) {
            cellData.cellIndex = xyzToOneDimIndex(
                cellData.z, cellData.x, cellData.y,
                inputCells.getZ(), inputCells.getX(), inputCells.getY()
            );
            inputCells.selectedCell = cellData.cellIndex;
            console.log( "clicked:  input cell %s", inputCells.selectedCell);
            updateCellRepresentations();
        }

        function spClicked(cellData) {
            cellData.cellIndex = xyzToOneDimIndex(
                cellData.z, cellData.x, cellData.y,
                spColumns.getZ(), spColumns.getX(), spColumns.getY()
            );
            if (columnSelection) {
                spColumns.selectedColumn = cellXyToColumnIndex(
                    cellData.x, cellData.y, spColumns.getX()
                );
            } else {
                spColumns.selectedColumn = undefined;
            }
            spColumns.selectedCell = cellData.cellIndex;
            console.log( "clicked:  col %s cell %s",
                spColumns.selectedColumn, spColumns.selectedCell);
            updateCellRepresentations();
        }

        function cellClicked(cellData) {
            if (cellData.type == 'inputCells') inputClicked(cellData);
            else spClicked(cellData);
        }

        function onDocumentMouseDown( event ) {
            event.preventDefault();

            // update the mouse variable
            var x = ( event.clientX / cellviz.renderer.domElement.clientWidth ) * 2 - 1;
            var y = - ( event.clientY / cellviz.renderer.domElement.clientHeight ) * 2 + 1;

            // find intersections
            // create a Ray with origin at the mouse position
            //   and direction into the scene (camera direction)
            var vector = new THREE.Vector3( x, y, 1 );
            vector.unproject(cellviz.camera);
            var ray = new THREE.Raycaster( cellviz.camera.position, vector.sub( cellviz.camera.position ).normalize() );
            // create an array containing all objects in the scene with which the ray intersects
            var intersects = ray.intersectObjects(cellviz.getTargets());

            // if there is one (or more) intersections
            if ( intersects.length > 0 ) {
                cellClicked(intersects[0].object._cellData);
            }
        }
        $('canvas').click(onDocumentMouseDown);
    }

    ////////////////////////////////////////////////////////////////////////////
    // CellViz functions
    ////////////////////////////////////////////////////////////////////////////

    function setupCellViz() {
        inputCells = new InputCells(inputDimensions, true);
        spColumns = new HtmMiniColumns(columnDimensions[0], cellsPerColumn, {
            cellsPerRow: defaultCellsPerRow
        });
        cellviz = new CompleteHtmVisualization(inputCells, spColumns, {
            camera: {
                x: 300,
                y: 2000,
                z: 8000
            }, spacing: defaultSpCellSpacing
        });
        clearAllCells();
        cellviz.render();
    }

    function clearAllCells() {
        spColumns.updateAll({state: cellStates.inactive});
        inputCells.updateAll({state: cellStates.inactive});
    }

    // Here be the logic that updates the cell-viz structures, thus enabling it
    // to animate along with the changing HTM state and responding to user
    // interaction. It be a long function.

    function cellStateIsActive(state) {
        return state == cellStates.active
            || state == cellStates.correctlyPredicted
            || state == cellStates.predictiveActive;
    }

    function cellStateIsPredictive(state) {
        return state == cellStates.predictive
            || state == cellStates.predictiveActive;
    }

    function selectCell(cellValue, activeSegments) {
        _.each(activeSegments, function(segment) {
            if (cellStateIsActive(cellValue.state)) {
                _.each(segment.synapses, function(synapse) {
                    if (synapse.presynapticCell == cellValue.cellIndex) {
                        // Active cells are the source for distal segments.
                        cellviz.distalSegments.push({
                            source: cellValue.cellIndex,
                            target: segment.cell
                        });
                    }
                });
            } else if (cellStateIsPredictive(cellValue.state)) {
                _.each(segment.synapses, function(synapse) {
                    if (segment.cell == cellValue.cellIndex) {
                        // Predictive cells are the source for distal segments.
                        cellviz.distalSegments.push({
                            source: synapse.presynapticCell,
                            target: segment.cell
                        });
                    }
                });
            }
        });
    }

    function selectColumn(columnIndex, activeSegments) {
        _.each(spColumns.getCellsInColumn(columnIndex), function(cellValue) {
            selectCell(cellValue, activeSegments);
        });
    }

    function selectInputCell(cellIndex, connectedSynapses) {
        var cell = inputCells.cells[cellIndex];
        console.log(connectedSynapses);
        _.each(connectedSynapses, function(columnSynapses, columnIndex) {
            _.each(columnSynapses, function(inputIndex) {
                if (inputIndex == cellIndex) {
                    cellviz.proximalSegments.push({
                        source: columnIndex,
                        target: inputIndex
                    });
                }
            });
        });
    }

    function updateCellRepresentations() {
        var inputEncoding = htmState.inputEncoding;
        var activeColumns = htmState.activeColumns;
        var activeDutyCycles = htmState.activeDutyCycles;
        var overlapDutyCycles = htmState.overlapDutyCycles;
        var potentialPools  = htmState.potentialPools;
        var connectedSynapses = htmState.connectedSynapses;
        var activeSegments = htmState.activeSegments;
        var predictiveCellIndices = htmState.predictiveCells;
        var receptiveField;
        var inhibitionMasks  = htmState.inhibitionMasks;
        var neighbors;
        var dutyCycle, minDutyCycle, maxDutyCycle, percent;
        var columnIndex, cellIndex;
        var globalCellIndex;
        var cx, cy, cz;
        var thisCellIndex, thisColumnIndex;
        var xMax, yMax, zMax;
        var color, state;

        var activeColumnIndices = SDR.tools.getActiveBits(activeColumns);
        var activeCellIndices = htmState.activeCells;

        _.each(inputEncoding, function(value, index) {
            color = cellStates.inactive.color;
            if (value == 1) {
                color = cellStates.input.color;
            }
            inputCells.update(index, {
                color: color,
                cellIndex: index
            });
        });

        _.times(spColumns.getNumberOfCells(), function(globalCellIndex) {
            var columnIndex = Math.floor(globalCellIndex / cellsPerColumn);

            if (activeColumnIndices.indexOf(columnIndex) > -1) {
                // Column is active.
                state = cellStates.withinActiveColumn;
            } else {
                state = cellStates.inactive;
            }

            if (activeCellIndices.indexOf(globalCellIndex) > -1) {
                // Cell is active.
                state = cellStates.active;
                if (predictiveCellIndices.indexOf(globalCellIndex) > -1) {
                    state = cellStates.predictiveActive;
                }
                if (lastPredictedCells.indexOf(globalCellIndex) > -1) {
                    state = cellStates.correctlyPredicted;
                }
            } else if (predictiveCellIndices.indexOf(globalCellIndex) > -1) {
                // Cell is predictive.
                state = cellStates.predictive;
            } else {
                // Cell is not active.
                if (predictiveCellIndices.indexOf(globalCellIndex) > -1) {
                    // Cell was predicted last step, but not active.
                    state = cellStates.wronglyPredicted;
                }
            }

            spColumns.update(globalCellIndex, {
                state: state,
                cellIndex: globalCellIndex,
                columnIndex: columnIndex
            });

        });

        cellviz.distalSegments = [];
        if (columnSelection && spColumns.selectedColumn) {
            selectColumn(spColumns.selectedColumn, activeSegments);
        } else if (spColumns.selectedCell){
            var cellValue = spColumns.cells[spColumns.selectedCell];
            selectCell(cellValue, activeSegments);
        }

        cellviz.proximalSegments = [];
        if (inputCells.selectedCell) {
            selectInputCell(inputCells.selectedCell, connectedSynapses);
        }

        cellviz.redraw();
    }

    function setupDatGui() {
        var params = {
            'input-x': 1.1,
            'input-y': 1.1,
            'input-z': 1.1,
            'sp-x': defaultSpCellSpacing.x,
            'sp-y': defaultSpCellSpacing.y,
            'sp-z': defaultSpCellSpacing.z,
            'cells per row': defaultCellsPerRow,
            // 'cell selection': cellSelection,
            'column selection': columnSelection
        };
        var minSpacing = 1.0;
        var maxSpacing = 10.0;
        var gui = new dat.GUI();

        var inputSpacing = gui.addFolder('Input Spacing');
        inputSpacing.add(params, 'input-x', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.x = spacing;
            updateCellRepresentations();
        });
        inputSpacing.add(params, 'input-y', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.y = spacing;
            updateCellRepresentations();
        });
        inputSpacing.add(params, 'input-z', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.inputSpacing.z = spacing;
            updateCellRepresentations();
        });

        var spSpacing = gui.addFolder('SP Spacing');
        spSpacing.add(params, 'sp-x', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.x = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'sp-y', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.y = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'sp-z', minSpacing, maxSpacing)
        .onChange(function(spacing) {
            cellviz.spacing.z = spacing;
            updateCellRepresentations();
        });
        spSpacing.add(params, 'cells per row').onChange(function(cells) {
            cellviz.redim(cells);
            updateCellRepresentations();
        });
        spSpacing.open();

        var selectionModes = gui.addFolder('Selection Modes');
        // selectionModes.add(params, 'cell selection').onChange(function(isOn) {
        //     cellSelection = isOn;
        // });
        selectionModes.add(params, 'column selection').onChange(function(isOn) {
            columnSelection = isOn;
        });
        selectionModes.open();
    }

    ////////////////////////////////////////
    // HTM-related functions
    ////////////////////////////////////////

    function getTmParams() {
        // TODO: Provide a UI to change TM Params.
        return {
            columnDimensions: columnDimensions,
            cellsPerColumn: cellsPerColumn,
            activationThreshold: 10,
            initialPermanence: 0.21,
            connectedPermanence: 0.50,
            minThreshold: 10,
            maxNewSynapseCount: 20,
            permanenceIncrement: 0.10,
            permanenceDecrement: 0.02,
            predictedSegmentDecrement: 0.0,
            maxSegmentsPerCell: 255,
            maxSynapsesPerSegment: 255
        };
    }

    function initModel(callback) {
        spClient = new HTM.SpatialPoolerClient();
        tmClient = new HTM.TemporalMemoryClient();
        loading(true);
        spClient.initialize(spParams.getParams(), function(spResp) {
            console.log('SP initialized.');
            var tmParams = getTmParams();
            tmClient.initialize(tmParams, {id: spClient._id}, function(tmResp) {
                console.log('TM initialized.');
                computeClient = new HTM.ComputeClient(tmClient._id);
                console.log('Compute client initialized.');
                loading(false);
                if (callback) callback(spResp, tmResp);
            });
        });
    }

    function getEncodingDetails(pads) {
        var on = [];
        var bucketIdx = bucketLabels.length;
        var actValue;
        _.each(pads, function(padOn, padIndex) {
            if (padOn) {
                on.push(noteNames[padIndex]);
            }
        });
        actValue = on.join('-');
        if (bucketLabels.indexOf(actValue) == -1) {
            bucketLabels.push(actValue);
        } else {
            bucketIdx = bucketLabels.indexOf(actValue);
        }
        return {
            bucketIdx: bucketIdx,
            actValue: actValue
        };
    }

    function encode(pads) {
        var n = inputDimensions[0];
        var buckets = 5;
        var bucketWidth = Math.floor(n / buckets);
        var out = SDR.tools.getEmpty(n);
        var encoding;
        var encodingDetails;
        _.each(pads, function(padOn, padIndex) {
            var start = padIndex * bucketWidth;
            if (padOn) {
                _.times(bucketWidth, function(cnt) {
                    out[start + cnt] = 1;
                });
            }
        });
        encodingDetails = getEncodingDetails(pads);
        encoding = SDR.tools.addNoise(out, noise);
        //console.log('%s in bucket %s', encodingDetails.actValue, encodingDetails.bucketIdx);
        return {
            encoding: encoding,
            bucketIdx: encodingDetails.bucketIdx,
            actValue: encodingDetails.actValue
        };
    }

    function runOnePointThroughSp(pads, beat) {
        // Encode data point into SDR.
        var raw = encode(pads);
        // Reset on last beat.
        var reset = beat == beats - 1;
        var encoding = raw.encoding;
        var bucketIdx = raw.bucketIdx;
        var actValue = raw.actValue;
        var computeConfig = {
          bucketIdx: bucketIdx,
          actValue: actValue,
          spLearn: false,
          tmLearn: learn,
          reset: reset,
          // getInhibitionMasks: true,
          // getPotentialPools: true,
          getPermanences: true,
          getActiveSegments: true,
          getConnectedSynapses: true,
        };

        counter++;

        if (reset) {
            console.log('TM Reset after this row of data.');
        }

        // Run encoding through SP/TM.
        computeClient.compute(encoding, computeConfig, function(err, response) {
            if (err) throw err;

            // Share the HTM state globally. Any renderers can inspect it
            // anytime to get current state.
            htmState = response;
            // Add the encoding as well.
            htmState.inputEncoding = encoding;
            // Stash current predictive cells to use for next render.
            lastPredictedCells = htmState.predictiveCells;
            updateCellRepresentations();

            updatePredictions(beat);
        });
    }

    ////////////////////////////////////////
    // Sequence interface
    ////////////////////////////////////////

    function play() {
        playing = true;
        loop.start();
    }

    function pause() {
        playing = false;
        loop.stop();
    }

    function processOneBeat(time, beat) {
        var pads = sequence[beat];
        var rest = 1;
        // Turn off the rest bit initially.
        pads[padCount] = 0;
        for (var i = 0; i < padCount; i++){
            if (pads[i] === 1){
                //slightly randomized velocities
                var vel = Math.random() * 0.5 + 0.5;
                keys.start(noteNames[i], time, 0, "32n", 0, vel);
            }
        }
        // If any pads are active, turn off the rest bit.
        if (pads.indexOf(1) > -1) {
            rest = 0;
        }
        pads[padCount] = rest;
        grid.find('td').removeClass('on-beat');
        grid.find('.beat-' + beat).addClass('on-beat');
        runOnePointThroughSp(pads, beat);
        lastBeat = beat;
    }

    ////////////////////////////////////////
    // Global Program Start
    ////////////////////////////////////////

    function start() {
        _.times(beats, function() {
            // Random initial beats
            var pads = [0, 0, 0, 0];
            var turnOn = getRandomInt(0, 5);
            if (pads[turnOn] !== undefined) pads[turnOn] = 1;
            sequence.push(pads);
        });
        // Setup a polyphonic sampler
        keys = new Tone.MultiPlayer({
            urls : {
                "A" : "./audio/casio/A1.mp3",
                "C#" : "./audio/casio/Cs2.mp3",
                "E" : "./audio/casio/E2.mp3",
                "F#" : "./audio/casio/Fs2.mp3",
            },
            volume : -10,
            fadeOut : 0.1,
        }).toMaster();
        // the notes
        noteNames = ["F#", "E", "C#", "A", "rest"];
        // Set up the SequencerInterface.
        grid = renderSequencerGrid('#sequencer-grid', beats, padCount);

        // Create a loop that runs through HTM on each beat.
        loop = new Tone.Sequence(
            processOneBeat, countIntsIntoArray(beats), beats + "n"
        );

        Tone.Transport.bpm.value = bpm;
        Tone.Transport.start();

        keys.connect(new Tone.Delay (0.75));

        $('h1').remove();

        window.addEventListener( 'keyup', function(event) {
            if (event.keyCode == 27) {
                spColumns.selectedCell = undefined;
                spColumns.selectedColumn = undefined;
                inputCells.selectedInput = undefined;
                updateCellRepresentations();
            }
        }, false );

        initModel(function(err, spResp, tmResp) {
            if (err) throw err;
            // Initial HTM state is not complete, but we'll show it anyway.
            htmState = _.extend(spResp, tmResp);
            setupCellViz();
            addClickHandling();
            setupDatGui();
            buildLegend();
            addDataControlHandlers();
            loading(false);
        });
    }

    start();

});
